import { db } from "@cap/database/cloudflare/application";
import { atomic } from "@cap/database/cloudflare/atomic";
import { videos, videoUploads } from "@cap/database/cloudflare/schema";
import { requireWritableVideo } from "@cap/web-backend/src/Videos/persistence";
import type { Video } from "@cap/web-domain";
import { eq } from "drizzle-orm";
import { startVideoProcessingWorkflow } from "./video-processing";

export async function startAdminReprocess(videoId: Video.VideoId) {
	const database = db();
	const now = new Date();
	const prepared = await atomic(database, async (snapshot) => {
		const video = await requireWritableVideo(snapshot, videoId);
		if (video.metadata?.editProcessing)
			throw new Error("Video is already being edited");
		const [upload] = await snapshot.read((reader) =>
			reader
				.select()
				.from(videoUploads)
				.where(eq(videoUploads.videoId, videoId))
				.limit(1),
		);
		const rawFileKey = `${video.ownerId}/${video.id}/result.mp4`;
		return {
			statements: upload
				? []
				: [
						database
							.insert(videoUploads)
							.values({
								videoId,
								mode: "singlepart",
								phase: "uploading",
								rawFileKey,
								startedAt: now,
								updatedAt: now,
							}),
					],
			result: {
				video,
				rawFileKey,
				expectedUpdatedAt: upload?.updatedAt ?? now,
			},
		};
	});
	await startVideoProcessingWorkflow({
		videoId,
		userId: prepared.video.ownerId,
		rawFileKey: prepared.rawFileKey,
		bucketId: prepared.video.bucket,
		processingMessage: "Queued admin reprocess...",
		startFailureMessage: "Admin reprocess could not start.",
		forceRestart: true,
		expectedUpdatedAt: prepared.expectedUpdatedAt,
		expectedProcessingToken:
			prepared.video.metadata?.processingRun?.token ?? null,
	});
	const [current] = await database
		.select()
		.from(videos)
		.where(eq(videos.id, videoId))
		.limit(1);
	if (!current?.metadata?.processingRun)
		throw new Error("Reprocessing run is unavailable");
	return { video: prepared.video, token: current.metadata.processingRun.token };
}
