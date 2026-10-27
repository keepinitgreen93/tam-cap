import { randomUUID } from "node:crypto";
import type { CloudflareDatabase } from "@cap/database/cloudflare";
import { atomic } from "@cap/database/cloudflare/atomic";
import { videos, videoUploads } from "@cap/database/cloudflare/schema";
import { createTranscriptInvalidation } from "@cap/database/cloudflare/transcript-publication";
import type { VideoProcessingRun } from "@cap/database/types";
import { requireWritableVideo } from "@cap/web-backend/src/Videos/persistence";
import { User, type Video } from "@cap/web-domain";
import { eq } from "drizzle-orm";
import { isVideoStorageKey } from "./video-storage-key";

export type ProcessingVideo = typeof videos.$inferSelect;
export type ProcessingClaim = {
	status: "started" | "already-processing" | "already-complete";
	run?: VideoProcessingRun;
	dispatch: boolean;
};

export class ProcessingRunSupersededError extends Error {
	constructor() {
		super("Video processing run was superseded");
this.name = "ProcessingRunSupersededError";
	}
}

const outputKeys = (
	ownerId: string,
	videoId: string,
	token: string,
	attemptId: string,
) => {
	const prefix = `${ownerId}/${videoId}/.recording/outputs/process-${token}/${attemptId}`;
	return {
		outputKey: `${prefix}/result.mp4`,
		thumbnailKey: `${prefix}/screen-capture.jpg`,
		previewKey: `${prefix}/animated-preview.gif`,
	};
};

export function matchesProcessingRun(
	video: ProcessingVideo,
	token: string,
	attemptId?: string,
) {
	const run = video.metadata?.processingRun;
	return Boolean(
		run &&
			run.token === token &&
			(!attemptId || run.attemptId === attemptId) &&
			run.ownerId === video.ownerId &&
			run.organizationId === video.orgId &&
			run.bucketId === video.bucket &&
			run.storageIntegrationId === video.storageIntegrationId &&
			(run.source === JSON.stringify(video.source) ||
				(run.state === "complete" &&
					"outputKey" in video.source &&
					video.source.outputKey === run.outputKey)),
	);
}

export async function claimVideoProcessing(
	database: CloudflareDatabase,
	input: {
		videoId: Video.VideoId;
		userId: string;
		rawFileKey: string;
		bucketId: string | null;
		processingMessage: string;
		mode?: "singlepart" | "multipart";
		forceRestart?: boolean;
		expectedUpdatedAt?: Date;
		expectedProcessingToken?: string | null;
	},
): Promise<ProcessingClaim> {
	const token = randomUUID();
	const attemptId = randomUUID();
	const now = new Date();
	return atomic<ProcessingClaim>(database, async (snapshot) => {
		const video = await requireWritableVideo(
			snapshot,
			input.videoId,
			User.UserId.make(input.userId),
		);
		if (
			!isVideoStorageKey(video, input.rawFileKey) ||
			video.bucket !== input.bucketId
		)
			throw new Error("Processing source does not belong to this video");
		const [upload] = await snapshot.read((reader) =>
			reader
				.select()
				.from(videoUploads)
				.where(eq(videoUploads.videoId, input.videoId))
				.limit(1),
		);
		if (!upload) throw new Error("No upload record found");
		const previous = video.metadata?.processingRun;
		if (
			previous &&
			matchesProcessingRun(video, previous.token) &&
			previous.rawFileKey === input.rawFileKey &&
			previous.state !== "complete" &&
			previous.state !== "error" &&
			previous.dispatch !== "accepted"
		) {
			if (now.getTime() - previous.dispatchStartedAt < 30_000)
				return {
					statements: [],
					result: {
						status: "already-processing",
						run: previous,
						dispatch: false,
					},
				};
			const run = {
				...previous,
				dispatchStartedAt: now.getTime(),
				dispatch: "pending" as const,
			};
			return {
				statements: [
					database
						.update(videos)
						.set({ metadata: { ...video.metadata, processingRun: run } })
						.where(eq(videos.id, video.id)),
				],
				result: { status: "started", run, dispatch: true },
			};
		}
		if (
			input.forceRestart &&
			(!input.expectedUpdatedAt ||
				input.expectedProcessingToken === undefined ||
				input.expectedProcessingToken !== (previous?.token ?? null) ||
				upload.updatedAt.getTime() !== input.expectedUpdatedAt.getTime())
		)
			return {
				statements: [],
				result: {
					status:
						upload.phase === "complete"
							? "already-complete"
							: "already-processing",
					dispatch: false,
				},
			};
		if (
			!input.forceRestart &&
			(upload.phase === "complete" ||
				upload.phase === "processing" ||
				upload.phase === "generating_thumbnail")
		)
			return {
				statements: [],
				result: {
					status:
						upload.phase === "complete"
							? "already-complete"
							: "already-processing",
					run: previous,
					dispatch: false,
				},
			};
		const run: VideoProcessingRun = {
			token,
			ownerId: video.ownerId,
			organizationId: video.orgId,
			bucketId: video.bucket,
			storageIntegrationId: video.storageIntegrationId,
			source: JSON.stringify(video.source),
			rawFileKey: input.rawFileKey,
			state: "queued",
			dispatch: "pending",
			dispatchStartedAt: now.getTime(),
			attempt: 0,
			attemptId,
			...outputKeys(video.ownerId, video.id, token, attemptId),
		};
		return {
			statements: [
				database
					.update(videos)
					.set({ metadata: { ...video.metadata, processingRun: run } })
					.where(eq(videos.id, video.id)),
				database
					.update(videoUploads)
					.set({
						...(input.mode ? { mode: input.mode } : {}),
						phase: "processing",
						processingProgress: 0,
						processingMessage: input.processingMessage,
						processingError: null,
						rawFileKey: input.rawFileKey,
						updatedAt: now,
					})
					.where(eq(videoUploads.videoId, video.id)),
			],
			result: { status: "started", run, dispatch: true },
		};
	});
}

export async function updateProcessingDispatch(
	database: CloudflareDatabase,
	videoId: Video.VideoId,
	token: string,
	patch: Pick<VideoProcessingRun, "dispatch"> &
		Partial<
			Pick<
				VideoProcessingRun,
				"workflowRunId" | "workflowQueue" | "deploymentId"
			>
		>,
) {
	return atomic(database, async (snapshot) => {
		const video = await requireWritableVideo(snapshot, videoId);
		if (!matchesProcessingRun(video, token))
			return { statements: [], result: false };
		const run = video.metadata?.processingRun;
		if (!run) throw new ProcessingRunSupersededError();
		return {
			statements: [
				database
					.update(videos)
					.set({
						metadata: {
							...video.metadata,
							processingRun: { ...run, ...patch },
						},
					})
					.where(eq(videos.id, videoId)),
			],
			result: true,
		};
	});
}

export async function claimProcessingAttempt(
	database: CloudflareDatabase,
	videoId: Video.VideoId,
	token: string,
	attempt: number,
) {
	const attemptId = randomUUID();
	const now = new Date();
	return atomic(database, async (snapshot) => {
		const video = await requireWritableVideo(snapshot, videoId);
		if (!matchesProcessingRun(video, token))
			throw new ProcessingRunSupersededError();
		const current = video.metadata?.processingRun;
		if (!current) throw new ProcessingRunSupersededError();
		if (current.attempt === attempt) return { statements: [], result: current };
		if (current.attempt + 1 !== attempt || current.state !== "error")
			throw new ProcessingRunSupersededError();
		const run: VideoProcessingRun = {
			...current,
			attempt,
			attemptId,
			state: "queued",
			jobId: undefined,
			error: undefined,
			...outputKeys(video.ownerId, video.id, token, attemptId),
		};
		return {
			statements: [
				database
					.update(videos)
					.set({ metadata: { ...video.metadata, processingRun: run } })
					.where(eq(videos.id, videoId)),
				database
					.update(videoUploads)
					.set({
						phase: "processing",
						processingError: null,
						processingProgress: 0,
						updatedAt: now,
					})
					.where(eq(videoUploads.videoId, videoId)),
			],
			result: run,
		};
	});
}

export async function applyVideoProcessingProgress(
	database: CloudflareDatabase,
	input: {
		videoId: Video.VideoId;
		token: string;
		attemptId: string;
		jobId?: string;
		phase: "processing" | "generating_thumbnail" | "complete" | "error";
		progress: number;
		message?: string;
		error?: string;
		metadata?: { duration: number; width: number; height: number; fps: number };
	},
) {
	if (!Number.isFinite(input.progress))
		throw new Error("Invalid processing progress");
	if (
		input.phase === "complete" &&
		(!input.metadata ||
			![input.metadata.width, input.metadata.height, input.metadata.fps].every(
				(value) => Number.isFinite(value) && value > 0,
			) ||
			!Number.isFinite(input.metadata.duration) ||
			input.metadata.duration < 0)
	)
		throw new Error("Completed processing metadata is invalid");
	const now = new Date();
	const invalidation = createTranscriptInvalidation();
	return atomic(database, async (snapshot) => {
		const [existing] = await snapshot.read((reader) =>
			reader.select().from(videos).where(eq(videos.id, input.videoId)).limit(1),
		);
		if (
			!existing ||
			!matchesProcessingRun(existing, input.token, input.attemptId)
		)
			return { statements: [], result: false };
		const video = await requireWritableVideo(
			snapshot,
			input.videoId,
			existing.ownerId,
		);
		const run = video.metadata?.processingRun;
		if (!run || (run.jobId && input.jobId && run.jobId !== input.jobId))
			return { statements: [], result: false };
		if (run.state === "complete") return { statements: [], result: false };
		if (run.state === "error" && input.phase !== "error")
			return { statements: [], result: false };
		const [upload] = await snapshot.read((reader) =>
			reader
				.select()
				.from(videoUploads)
				.where(eq(videoUploads.videoId, video.id))
				.limit(1),
		);
		if (!upload || upload.rawFileKey !== run.rawFileKey)
			return { statements: [], result: false };
		const complete = input.phase === "complete";
		const next: VideoProcessingRun = {
			...run,
			state: complete
				? "complete"
				: input.phase === "error"
					? "error"
					: "processing",
			jobId: input.jobId ?? run.jobId,
			error:
				input.phase === "error"
					? (input.error ?? input.message ?? "Video processing failed")
					: undefined,
			...(complete ? { completedAt: now.toISOString() } : {}),
		};
		return {
			statements: [
				database
					.update(videos)
					.set({
						metadata: {
							...video.metadata,
							processingRun: next,
							...(complete
								? {
										transcriptPublication: invalidation,
										editTranscriptBackfill: undefined,
										liveTranscript: undefined,
									}
								: {}),
						},
						...(complete && input.metadata
							? {
									transcriptionStatus: null,
									width: input.metadata.width,
									height: input.metadata.height,
									fps: input.metadata.fps,
									...(input.metadata.duration > 0
										? { duration: input.metadata.duration }
										: {}),
									source: {
										type: "webMP4" as const,
										outputKey: run.outputKey,
										thumbnailKey: run.thumbnailKey,
										previewKey: run.previewKey,
									},
								}
							: {}),
						updatedAt: now,
					})
					.where(eq(videos.id, video.id)),
				database
					.update(videoUploads)
					.set({
						phase: input.phase,
						processingProgress: Math.max(
							upload.processingProgress,
							Math.min(100, Math.max(0, Math.round(input.progress))),
						),
						processingMessage: input.message,
						processingError:
							input.phase === "error"
								? (input.error ?? input.message ?? "Video processing failed")
								: null,
						updatedAt: now,
					})
					.where(eq(videoUploads.videoId, video.id)),
			],
			result: true,
		};
	});
}
