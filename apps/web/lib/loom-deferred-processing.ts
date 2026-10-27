import { requireActiveOrganization } from "@cap/database/cloudflare/access";
import { db } from "@cap/database/cloudflare/application";
import { atomic } from "@cap/database/cloudflare/atomic";
import { videos, videoUploads } from "@cap/database/cloudflare/schema";
import type { VideoMetadata } from "@cap/database/types";
import type { Video } from "@cap/web-domain";
import { eq } from "drizzle-orm";
import { LOOM_REASSIGN_CLAIM_TTL_MS } from "@/lib/loom-original-key";
import { startVideoProcessingWorkflow } from "@/lib/video-processing";

export const DEFERRED_PROCESSING_RECLAIM_MS = 30 * 60 * 1000;

export function getPendingLoomProcessing(
	metadata: VideoMetadata | null | undefined,
	ownerId: string,
	videoId: string,
	now = Date.now(),
) {
	const deferred = metadata?.loomDeferredProcessing;
	if (
		!deferred ||
		typeof deferred.rawFileKey !== "string" ||
		!deferred.rawFileKey.startsWith(`${ownerId}/${videoId}/`)
	)
		return null;
	if (deferred.status === "pending") return deferred.rawFileKey;
	const startedAt = Date.parse(deferred.startedAt ?? "");
	return deferred.status === "started" &&
		Number.isFinite(startedAt) &&
		now - startedAt > DEFERRED_PROCESSING_RECLAIM_MS
		? deferred.rawFileKey
		: null;
}

export async function startDeferredLoomProcessing(
	{
		videoId,
		ownerId,
		bucketId,
		rawFileKey,
	}: {
		videoId: Video.VideoId;
		ownerId: string;
		bucketId: string | null;
		rawFileKey: string;
	},
	now = new Date(),
) {
	const startedAt = now.toISOString();
	const database = db();
	const claimed = await atomic(database, async (snapshot) => {
		const [video] = await snapshot.read((reader) =>
			reader.select().from(videos).where(eq(videos.id, videoId)).limit(1),
		);
		if (
			!video ||
			video.ownerId !== ownerId ||
			video.bucket !== bucketId ||
			getPendingLoomProcessing(
				video.metadata,
				ownerId,
				videoId,
				now.getTime(),
			) !== rawFileKey
		)
			return { statements: [], result: false };
		if (video.orgId) await requireActiveOrganization(snapshot, video.orgId);
		const move = video.metadata?.loomReassignClaim;
		if (
			move &&
			Date.parse(move.at) >= now.getTime() - LOOM_REASSIGN_CLAIM_TTL_MS
		)
			return { statements: [], result: false };
		return {
			statements: [
				database
					.update(videos)
					.set({
						metadata: {
							...video.metadata,
							loomDeferredProcessing: {
								rawFileKey,
								status: "started",
								startedAt,
							},
						},
					})
					.where(eq(videos.id, videoId)),
				database
					.insert(videoUploads)
					.values({
						videoId,
						mode: "singlepart",
						phase: "uploading",
						rawFileKey,
						processingMessage: "Optimizing imported video...",
					})
					.onConflictDoUpdate({
						target: videoUploads.videoId,
						set: { rawFileKey, phase: "uploading" },
					}),
			],
			result: true,
		};
	});
	if (!claimed) return "already-started" as const;

	return startVideoProcessingWorkflow({
		videoId,
		userId: ownerId,
		rawFileKey,
		bucketId,
		processingMessage: "Optimizing imported video...",
		startFailureMessage: "Imported video could not be optimized",
	});
}
