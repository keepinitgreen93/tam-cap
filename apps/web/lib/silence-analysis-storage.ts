import "server-only";

import { createHash } from "node:crypto";
import { db } from "@cap/database/cloudflare/application";
import { atomic } from "@cap/database/cloudflare/atomic";
import { videos } from "@cap/database/cloudflare/schema";
import { Storage } from "@cap/web-backend";
import { getRecordingObjectIdentity } from "@cap/web-backend/src/Storage/recording-object-identity";
import { Video } from "@cap/web-domain";
import { eq } from "drizzle-orm";
import { Option } from "effect";
import {
	readSilenceClaim,
	type SilenceClaim,
	silenceAnalysisSchema,
} from "@/lib/silence-analysis-contract";
import { decodeStorageVideo } from "@/lib/video-storage";
import { runWorkflowPromise } from "@/lib/workflow-runtime";

export async function loadSilenceSource(
	videoId: Video.VideoId,
	ownerId: string,
) {
	const [video] = await db()
		.select()
		.from(videos)
		.where(eq(videos.id, videoId));
	if (
		!video ||
		video.ownerId !== ownerId ||
		video.isScreenshot ||
		!video.duration ||
		video.duration <= 0 ||
		video.metadata?.editProcessing
	)
		throw new Error("Video is not available for silence analysis");
	const storageVideo = decodeStorageVideo(video);
	const source = Video.Video.getSource(storageVideo);
	if (!(source instanceof Video.Mp4Source))
		throw new Error("Silence analysis requires a completed MP4 recording");
	const [bucket] =
		await Storage.getAccessForVideo(storageVideo).pipe(runWorkflowPromise);
	const key = source.getFileKey();
	const head = await bucket.headObject(key).pipe(runWorkflowPromise);
	const identity = getRecordingObjectIdentity(head);
	if (!identity || !head.ContentLength)
		throw new Error("Video revision is unavailable");
	const durationMs = Math.round(video.duration * 1000);
	const revision = createHash("sha256")
		.update(JSON.stringify([video.id, key, identity, durationMs]))
		.digest("hex");
	return {
		video,
		bucket,
		key,
		identity,
		contentLength: head.ContentLength,
		revision,
		durationMs,
		resultKey: `${ownerId}/${videoId}/.recording/silence/${revision}.json`,
	};
}

export async function readSilenceResult(
	source: Awaited<ReturnType<typeof loadSilenceSource>>,
) {
	const object = await source.bucket
		.getObject(source.resultKey)
		.pipe(runWorkflowPromise);
	if (Option.isNone(object)) return null;
	const result = silenceAnalysisSchema.parse(JSON.parse(object.value));
	if (result.durationMs !== source.durationMs)
		throw new Error("Silence result revision is invalid");
	return result;
}

export async function updateSilenceClaim(
	videoId: Video.VideoId,
	ownerId: string,
	requestId: string,
	update: Partial<Pick<SilenceClaim, "status" | "runId">>,
) {
	return atomic(db(), async (snapshot) => {
		const [video] = await snapshot.read((database) =>
			database.select().from(videos).where(eq(videos.id, videoId)),
		);
		const claim = readSilenceClaim(video?.metadata);
		if (!video || video.ownerId !== ownerId || claim?.requestId !== requestId)
			return { statements: [], result: false };
		const metadata = {
			...video.metadata,
			silenceAnalysis: { ...claim, ...update },
		};
		return {
			statements: [
				db().update(videos).set({ metadata }).where(eq(videos.id, videoId)),
			],
			result: true,
		};
	});
}
