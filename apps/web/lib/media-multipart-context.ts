import type { CloudflareDatabase } from "@cap/database/cloudflare";
import { atomic } from "@cap/database/cloudflare/atomic";
import {
	s3Buckets,
	storageIntegrations,
	videoProcessingJobs,
	videos,
} from "@cap/database/cloudflare/schema";
import { writableVideo } from "@cap/web-backend/src/Videos/persistence";
import { Video } from "@cap/web-domain";
import { and, eq } from "drizzle-orm";
import { getDesktopRecordingOutputKey } from "./desktop-recording-source";

type MultipartPayload = {
	videoId: string;
	key: string;
	uploadId: string;
	loomImportAttemptId?: string;
	generation?: string;
	attemptId?: string;
};
type MultipartVideoContext =
	| { error: string; status: number }
	| { video: typeof videos.$inferSelect; fenced: boolean; loom: boolean };

export async function getMediaMultipartVideo(
	database: CloudflareDatabase,
	payload: MultipartPayload,
	allowExpired = false,
): Promise<MultipartVideoContext> {
	return atomic<MultipartVideoContext>(database, async (snapshot) => {
		const id = Video.VideoId.make(payload.videoId);
		const [existing] = await snapshot.read((reader) =>
			reader.select({ id: videos.id }).from(videos).where(eq(videos.id, id)),
		);
		const reject = (error: string, status = 409) => ({
			statements: [],
			result: { error, status },
		});
		if (!existing) return reject("Video not found", 404);
		const [video] = await snapshot.read((reader) =>
			reader
				.select()
				.from(videos)
				.where(and(writableVideo, eq(videos.id, id))),
		);
		if (!video) return reject("Recording is no longer writable");
		if (video.storageIntegrationId) {
			const integrationId = video.storageIntegrationId;
			const [integration] = await snapshot.read((reader) =>
				reader
					.select()
					.from(storageIntegrations)
					.where(eq(storageIntegrations.id, integrationId)),
			);
			if (
				!integration ||
				integration.status !== "active" ||
				(integration.organizationId
					? integration.organizationId !== video.orgId
					: integration.ownerId !== video.ownerId)
			)
				return reject("Recording storage is no longer current");
		}
		if (video.bucket) {
			const bucketId = video.bucket;
			const [bucket] = await snapshot.read((reader) =>
				reader.select().from(s3Buckets).where(eq(s3Buckets.id, bucketId)),
			);
			if (
				!bucket?.active ||
				(bucket.organizationId
					? bucket.organizationId !== video.orgId
					: bucket.ownerId !== video.ownerId)
			)
				return reject("Recording storage is no longer current");
		}
		const [job] = await snapshot.read((reader) =>
			reader
				.select()
				.from(videoProcessingJobs)
				.where(eq(videoProcessingJobs.videoId, id)),
		);
		const fenced =
			payload.generation !== undefined || payload.attemptId !== undefined;
		const loom =
			payload.loomImportAttemptId !== undefined ||
			video.metadata?.loomImportUpload !== undefined;
		if (loom) {
			const receipt = video.metadata?.loomImportUpload;
			const upload = [receipt?.source, receipt?.output].find(
				(value) =>
					value?.key === payload.key && value.uploadId === payload.uploadId,
			);
			if (
				fenced ||
				!receipt ||
				receipt.attemptId !== payload.loomImportAttemptId ||
				(video.metadata?.loomImportRun &&
					!receipt.attemptId.startsWith(
						`${video.metadata.loomImportRun.runId}:`,
					)) ||
				receipt.ownerId !== video.ownerId ||
				receipt.organizationId !== video.orgId ||
				!upload ||
				!payload.key.startsWith(`${video.ownerId}/${video.id}/`)
			)
				return reject("Loom import upload is no longer current");
		}
		const expectedKey =
			fenced && payload.generation && payload.attemptId
				? getDesktopRecordingOutputKey(
						video.ownerId,
						video.id,
						payload.generation,
						payload.attemptId,
					)
				: `${video.ownerId}/${video.id}/result.mp4`;
		if (
			(!loom && payload.key !== expectedKey) ||
			(fenced && (!payload.generation || !payload.attemptId))
		)
			return reject("Invalid multipart upload key", 400);
		if (
			fenced &&
			!allowExpired &&
			(!job ||
				job.ownerId !== video.ownerId ||
				job.state !== "processing" ||
				!job.source ||
				job.generation !== payload.generation ||
				job.attemptId !== payload.attemptId ||
				!job.leaseExpiresAt ||
				job.leaseExpiresAt <= new Date())
		)
			return reject("Recording attempt is no longer active");
		if (
			!fenced &&
			!loom &&
			(job ||
				video.metadata?.processingRun ||
				video.metadata?.transcriptPublication ||
				video.metadata?.editProcessing ||
				("outputKey" in video.source && video.source.outputKey))
		)
			return reject("Legacy multipart upload is no longer current");
		return { statements: [], result: { video, fenced, loom } };
	});
}
