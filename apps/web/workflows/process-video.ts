import { db } from "@cap/database/cloudflare/application";
import { users, videos } from "@cap/database/cloudflare/schema";
import { serverEnv } from "@cap/env";
import { Storage } from "@cap/web-backend/src/Storage/index";
import { Video } from "@cap/web-domain";
import { eq } from "drizzle-orm";
import { FatalError, sleep } from "workflow";
import { isAiGenerationEnabledForUser } from "@/lib/ai-generation-entitlement";
import {
	createMediaServerCapacityError,
	isMediaServerCapacityError,
} from "@/lib/media-server-backpressure";
import { transcribeVideo } from "@/lib/transcribe";
import {
	applyVideoProcessingProgress,
	claimProcessingAttempt,
	matchesProcessingRun,
	ProcessingRunSupersededError,
} from "@/lib/video-processing-state";
import { decodeStorageVideo } from "@/lib/video-storage";
import { runWorkflowPromise } from "@/lib/workflow-runtime";
import {
	type ProcessedVideoMetadata,
	VideoProcessingFailedError,
	waitForVideoProcessing,
} from "./video-processing-status";

interface ProcessVideoWorkflowPayload {
	videoId: string;
	userId: string;
	rawFileKey: string;
	bucketId: string | null;
	processingToken: string;
}

interface VideoProcessingResult {
	success: boolean;
	message: string;
	metadata?: {
		duration: number;
		width: number;
		height: number;
		fps: number;
	};
}

export async function processVideoWorkflow(
	payload: ProcessVideoWorkflowPayload,
): Promise<VideoProcessingResult> {
	"use workflow";

	const { videoId, userId, rawFileKey, bucketId, processingToken } = payload;
	let attemptId: string | undefined;

	try {
		await validateProcessingRequest(
			videoId,
			rawFileKey,
			processingToken,
			userId,
		);

		let metadata: ProcessedVideoMetadata;
		for (let processingAttempt = 0; ; processingAttempt++) {
			const attempt = await beginProcessingAttempt(
				videoId,
				processingToken,
				processingAttempt,
			);
			attemptId = attempt.attemptId;
			let capacityRetryCount = 0;
			while (true) {
				try {
					await processVideoOnMediaServer(
						videoId,
						userId,
						rawFileKey,
						bucketId,
						processingToken,
						attemptId,
					);
					break;
				} catch (error) {
					if (!isMediaServerCapacityError(error)) throw error;
					await markVideoWaitingForCapacity(
						videoId,
						processingToken,
						attemptId,
					);
					await sleep(`${Math.min(120, 15 + capacityRetryCount * 15)}s`);
					capacityRetryCount++;
				}
			}
			try {
				metadata = await waitForVideoProcessing(
					videoId,
					processingToken,
					attemptId,
				);
				break;
			} catch (error) {
				if (
					!(error instanceof VideoProcessingFailedError) ||
					processingAttempt >= 2
				) {
					throw error;
				}
				await markVideoWaitingForCapacity(videoId, processingToken, attemptId);
				await sleep(15_000 * (processingAttempt + 1));
			}
		}

		await confirmProcessingComplete(videoId, processingToken, attemptId);
		await queueProcessedVideoTranscription(videoId, processingToken);

		return {
			success: true,
			message: "Video processing completed",
			metadata,
		};
	} catch (error) {
		const errorMessage = error instanceof Error ? error.message : String(error);
		if (attemptId && !(error instanceof Error && error.name === "ProcessingRunSupersededError"))
			await setProcessingError(
				videoId,
				processingToken,
				attemptId,
				errorMessage,
			);
		throw new FatalError(errorMessage);
	}
}

async function beginProcessingAttempt(
	videoId: string,
	token: string,
	attempt: number,
) {
	"use step";
	return claimProcessingAttempt(
		db(),
		Video.VideoId.make(videoId),
		token,
		attempt,
	);
}

async function validateProcessingRequest(
	videoId: string,
	rawFileKey: string,
	token: string,
	userId: string,
): Promise<void> {
	"use step";
	if (!serverEnv().MEDIA_SERVER_URL)
		throw new FatalError("MEDIA_SERVER_URL is not configured");
	const [video] = await db()
		.select()
		.from(videos)
		.where(eq(videos.id, Video.VideoId.make(videoId)));
	if (
		!video ||
		video.ownerId !== userId ||
		!matchesProcessingRun(video, token) ||
		video.metadata?.processingRun?.rawFileKey !== rawFileKey
	)
		throw new FatalError("Processing source or ownership changed");
}

const MEDIA_SERVER_START_MAX_ATTEMPTS = 2;
const MEDIA_SERVER_START_RETRY_BASE_MS = 250;
const MEDIA_SERVER_PRESIGNED_GET_EXPIRES_SECONDS = 3 * 60 * 60;
const MEDIA_SERVER_PRESIGNED_PUT_EXPIRES_SECONDS = 3 * 60 * 60;

function getInputExtension(rawFileKey: string): string {
	const parts = rawFileKey.split(".");
	const extension = parts.at(-1)?.toLowerCase();

	if (!extension) {
		return ".mp4";
	}

	return `.${extension}`;
}

async function waitForRetry(delayMs: number): Promise<void> {
	await new Promise((resolve) => setTimeout(resolve, delayMs));
}

async function startMediaServerProcessJob(
	mediaServerUrl: string,
	body: {
		videoId: string;
		userId: string;
		videoUrl: string;
		outputPresignedUrl: string;
		thumbnailPresignedUrl: string;
		previewGifPresignedUrl: string;
		webhookUrl: string;
		webhookSecret?: string;
		inputExtension: string;
		audioLevels?: boolean;
		processingToken: string;
		processingInputKey: string;
		processingOutputKey: string;
		importedOriginal?: boolean;
	},
): Promise<string> {
	for (let attempt = 0; attempt < MEDIA_SERVER_START_MAX_ATTEMPTS; attempt++) {
		const headers: Record<string, string> = {
			"Content-Type": "application/json",
		};
		if (body.webhookSecret) {
			headers["x-media-server-secret"] = body.webhookSecret;
		}

		const response = await fetch(`${mediaServerUrl}/video/process`, {
			method: "POST",
			headers,
			body: JSON.stringify(body),
		});

		if (response.ok) {
			const { jobId } = (await response.json()) as { jobId: string };
			return jobId;
		}

		const errorData = (await response.json().catch(() => ({}))) as {
			error?: string;
			code?: string;
			details?: string;
			instanceId?: string;
			pid?: number;
			activeVideoProcesses?: number;
			maxConcurrentVideoProcesses?: number;
			jobCount?: number;
		};
		const baseErrorMessage =
			errorData.error ||
			errorData.details ||
			"Video processing failed to start";
		const busyDiagnostics =
			errorData.code === "SERVER_BUSY"
				? [
						errorData.instanceId ? `instance=${errorData.instanceId}` : null,
						typeof errorData.pid === "number" ? `pid=${errorData.pid}` : null,
						typeof errorData.activeVideoProcesses === "number" &&
						typeof errorData.maxConcurrentVideoProcesses === "number"
							? `active=${errorData.activeVideoProcesses}/${errorData.maxConcurrentVideoProcesses}`
							: null,
						typeof errorData.jobCount === "number"
							? `jobCount=${errorData.jobCount}`
							: null,
					]
						.filter(Boolean)
						.join(", ")
				: "";
		const errorMessage = busyDiagnostics
			? `${baseErrorMessage} (${busyDiagnostics})`
			: baseErrorMessage;
		const shouldRetry =
			response.status === 503 &&
			(errorData.code === "SERVER_BUSY" ||
				errorMessage.includes("Server is busy"));

		if (shouldRetry && attempt < MEDIA_SERVER_START_MAX_ATTEMPTS - 1) {
			await waitForRetry(MEDIA_SERVER_START_RETRY_BASE_MS * 2 ** attempt);
			continue;
		}

		if (shouldRetry) {
			throw createMediaServerCapacityError({
				response,
				message: errorMessage,
				videoId: body.videoId,
			});
		}

		throw new Error(errorMessage);
	}

	throw new Error("Video processing failed to start");
}

async function processVideoOnMediaServer(
	videoId: string,
	userId: string,
	rawFileKey: string,
	_bucketId: string | null,
	processingToken: string,
	attemptId: string,
): Promise<void> {
	"use step";

	const mediaServerUrl = serverEnv().MEDIA_SERVER_URL;
	const webhookBaseUrl =
		serverEnv().MEDIA_SERVER_WEBHOOK_URL || serverEnv().WEB_URL;
	if (!mediaServerUrl) {
		throw new FatalError("MEDIA_SERVER_URL is not configured");
	}

	const [video] = await db()
		.select()
		.from(videos)
		.where(eq(videos.id, Video.VideoId.make(videoId)));

	if (!video || !matchesProcessingRun(video, processingToken, attemptId))
		throw new ProcessingRunSupersededError();
	const processingRun = video.metadata?.processingRun;
	if (!processingRun) throw new ProcessingRunSupersededError();
	if (processingRun.state === "complete") return;

	const videoDomain = decodeStorageVideo(video);

	const [bucket] =
		await Storage.getAccessForVideo(videoDomain).pipe(runWorkflowPromise);

	const rawVideoUrl = await bucket
		.getInternalSignedObjectUrl(rawFileKey, {
			expiresIn: MEDIA_SERVER_PRESIGNED_GET_EXPIRES_SECONDS,
		})
		.pipe(runWorkflowPromise);

	const outputKey = processingRun.outputKey;
	const thumbnailKey = processingRun.thumbnailKey;
	const previewGifKey = processingRun.previewKey;

	const outputPresignedUrl = await bucket
		.getInternalPresignedPutUrl(
			outputKey,
			{
				ContentType: "video/mp4",
			},
			{ expiresIn: MEDIA_SERVER_PRESIGNED_PUT_EXPIRES_SECONDS },
		)
		.pipe(runWorkflowPromise);

	const thumbnailPresignedUrl = await bucket
		.getInternalPresignedPutUrl(
			thumbnailKey,
			{
				ContentType: "image/jpeg",
			},
			{ expiresIn: MEDIA_SERVER_PRESIGNED_PUT_EXPIRES_SECONDS },
		)
		.pipe(runWorkflowPromise);

	const previewGifPresignedUrl = await bucket
		.getInternalPresignedPutUrl(
			previewGifKey,
			{
				ContentType: "image/gif",
				CacheControl: "public, max-age=31536000, immutable",
			},
			{ expiresIn: MEDIA_SERVER_PRESIGNED_PUT_EXPIRES_SECONDS },
		)
		.pipe(runWorkflowPromise);

	const webhookUrl = `${webhookBaseUrl}/api/webhooks/media-server/progress?processingRun=${encodeURIComponent(processingToken)}&processingAttempt=${encodeURIComponent(attemptId)}`;
	const webhookSecret = serverEnv().MEDIA_SERVER_WEBHOOK_SECRET;

	const active = await applyVideoProcessingProgress(db(), {
		videoId: Video.VideoId.make(videoId),
		token: processingToken,
		attemptId,
		phase: "processing",
		progress: 0,
		message: "Starting video processing...",
	});
	if (!active) {
		const [current] = await db()
			.select()
			.from(videos)
			.where(eq(videos.id, Video.VideoId.make(videoId)));
		if (
			current &&
			matchesProcessingRun(current, processingToken, attemptId) &&
			current.metadata?.processingRun?.state === "complete"
		)
			return;
		throw new ProcessingRunSupersededError();
	}

	await startMediaServerProcessJob(mediaServerUrl, {
		processingToken: attemptId,
		processingInputKey: rawFileKey,
		processingOutputKey: outputKey,
		audioLevels: video.source.type === "webMP4",
		videoId,
		userId,
		videoUrl: rawVideoUrl,
		outputPresignedUrl,
		thumbnailPresignedUrl,
		previewGifPresignedUrl,
		webhookUrl,
		webhookSecret: webhookSecret || undefined,
		inputExtension: getInputExtension(rawFileKey),
		importedOriginal:
			video.metadata?.loomDeferredProcessing?.rawFileKey === rawFileKey ||
			undefined,
	});
}

async function confirmProcessingComplete(
	videoId: string,
	token: string,
	attemptId: string,
) {
	"use step";
	const [video] = await db()
		.select()
		.from(videos)
		.where(eq(videos.id, Video.VideoId.make(videoId)));
	if (
		!video ||
		!matchesProcessingRun(video, token, attemptId) ||
		video.metadata?.processingRun?.state !== "complete"
	)
		throw new ProcessingRunSupersededError();
}

async function queueProcessedVideoTranscription(
	videoId: string,
	processingToken: string,
): Promise<void> {
	"use step";

	try {
		const [current] = await db()
			.select()
			.from(videos)
			.where(eq(videos.id, Video.VideoId.make(videoId)));
		if (
			!current ||
			!matchesProcessingRun(current, processingToken) ||
			current.metadata?.processingRun?.state !== "complete"
		)
			return;
		const [owner] = await db()
			.select({
				id: videos.ownerId,
				stripeSubscriptionStatus: users.stripeSubscriptionStatus,
				thirdPartyStripeSubscriptionId: users.thirdPartyStripeSubscriptionId,
			})
			.from(videos)
			.innerJoin(users, eq(videos.ownerId, users.id))
			.where(eq(videos.id, Video.VideoId.make(videoId)));

		if (!owner) return;

		const result = await transcribeVideo(
			Video.VideoId.make(videoId),
			owner.id,
			isAiGenerationEnabledForUser(owner),
		);

		if (!result.success) {
			console.warn("[process-video] Failed to queue transcription", {
				videoId,
				message: result.message,
			});
		}
	} catch (error) {
		console.warn("[process-video] Failed to queue transcription", {
			videoId,
			error,
		});
	}
}

async function setProcessingError(
	videoId: string,
	token: string,
	attemptId: string,
	errorMessage: string,
): Promise<void> {
	"use step";
	await applyVideoProcessingProgress(db(), {
		videoId: Video.VideoId.make(videoId),
		token,
		attemptId,
		phase: "error",
		progress: 0,
		message: "Video processing failed",
		error: errorMessage,
	});
}

async function markVideoWaitingForCapacity(
	videoId: string,
	token: string,
	attemptId: string,
): Promise<void> {
	"use step";
	await applyVideoProcessingProgress(db(), {
		videoId: Video.VideoId.make(videoId),
		token,
		attemptId,
		phase: "processing",
		progress: 0,
		message: "Queued for video processing...",
	});
}
