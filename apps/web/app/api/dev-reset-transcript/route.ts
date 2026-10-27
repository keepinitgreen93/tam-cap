import { randomUUID } from "node:crypto";
import { isCrossSiteCookieWrite } from "@cap/database/auth/request-site";
import { getCurrentUser } from "@cap/database/auth/session";
import { requireActiveOrganization } from "@cap/database/cloudflare/access";
import { db } from "@cap/database/cloudflare/application";
import { atomic } from "@cap/database/cloudflare/atomic";
import {
	videoEdits,
	videos,
	videoUploads,
} from "@cap/database/cloudflare/schema";
import {
	createTranscriptInvalidation,
	getTranscriptPublication,
	transcriptMediaRevision,
} from "@cap/database/cloudflare/transcript-publication";
import { Storage } from "@cap/web-backend";
import type { Video } from "@cap/web-domain";
import { and, eq } from "drizzle-orm";
import type { NextRequest } from "next/server";
import { runPromise } from "@/lib/server";
import { decodeStorageVideo } from "@/lib/video-storage";

export async function POST(request: NextRequest) {
	if (process.env.NODE_ENV !== "development") {
		return Response.json({ error: "dev only" }, { status: 403 });
	}
	if (request.headers.get("origin") !== request.nextUrl.origin) {
		return Response.json({ error: "same origin required" }, { status: 403 });
	}
	const user = isCrossSiteCookieWrite(request) ? null : await getCurrentUser();
	if (!user) {
		return Response.json({ error: "unauthorized" }, { status: 401 });
	}
	const videoIdParam = request.nextUrl.searchParams.get("videoId");
	if (!videoIdParam) {
		return Response.json({ error: "videoId required" }, { status: 400 });
	}
	const videoId = videoIdParam as Video.VideoId;

	const [video] = await db()
		.select()
		.from(videos)
		.where(and(eq(videos.id, videoId), eq(videos.ownerId, user.id)));
	if (!video) {
		return Response.json({ error: "video not found" }, { status: 404 });
	}

	const [bucket] = await Storage.getAccessForVideo(
		decodeStorageVideo(video),
	).pipe(runPromise);

	const [edit] = await db()
		.select()
		.from(videoEdits)
		.where(eq(videoEdits.videoId, videoId));
	const restoredKey = edit
		? `${video.ownerId}/${video.id}/.recording/reset/${randomUUID()}/result.mp4`
		: null;
	if (edit && restoredKey)
		await bucket
			.copyObject(`${bucket.bucketName}/${edit.sourceKey}`, restoredKey)
			.pipe(runPromise);
	const invalidation = createTranscriptInvalidation();
	const database = db();
	await atomic(database, async (snapshot) => {
		const [current] = await snapshot.read((reader) =>
			reader.select().from(videos).where(eq(videos.id, videoId)).limit(1),
		);
		const [currentEdit] = await snapshot.read((reader) =>
			reader
				.select()
				.from(videoEdits)
				.where(eq(videoEdits.videoId, videoId))
				.limit(1),
		);
		if (
			!current ||
			current.ownerId !== user.id ||
			transcriptMediaRevision(current) !== transcriptMediaRevision(video) ||
			getTranscriptPublication(current)?.id !==
				getTranscriptPublication(video)?.id ||
			JSON.stringify(currentEdit ?? null) !== JSON.stringify(edit ?? null)
		)
			throw new Error("Video changed during reset");
		if (current.orgId) await requireActiveOrganization(snapshot, current.orgId);
		const metadata = {
			...current.metadata,
			transcriptPublication: invalidation,
		};
		delete metadata.summary;
		delete metadata.chapters;
		delete metadata.aiGenerationStatus;
		delete metadata.aiGenerationRun;
		delete metadata.editTranscriptBackfill;
		delete metadata.transcriptionRun;
		delete metadata.liveTranscript;
		delete metadata.completedVideoEdit;
		delete metadata.editProcessing;
		delete metadata.processingRun;
		delete metadata.desktopRecordingUpload;
		return {
			statements: [
				database
					.update(videos)
					.set({
						transcriptionStatus: null,
						metadata,
						...(restoredKey && edit
							? {
									duration: edit.editSpec.sourceDuration,
									source: {
										type: "desktopMP4" as const,
										outputKey: restoredKey,
									},
								}
							: {}),
					})
					.where(eq(videos.id, videoId)),
				database.delete(videoEdits).where(eq(videoEdits.videoId, videoId)),
				database.delete(videoUploads).where(eq(videoUploads.videoId, videoId)),
			],
			result: undefined,
		};
	});
	const deleted: string[] = [];
	const restoredOriginal = Boolean(edit);
	const restoredDuration = edit?.editSpec.sourceDuration ?? null;

	return Response.json({
		ok: true,
		resolvedBucket: bucket.bucketName,
		deleted,
		restoredOriginal,
		restoredDuration,
	});
}
