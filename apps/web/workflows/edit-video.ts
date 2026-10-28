import { createHash } from "node:crypto";
import {
	CloudFrontClient,
	CreateInvalidationCommand,
} from "@aws-sdk/client-cloudfront";
import { db } from "@cap/database/cloudflare/application";
import type { AtomicStatement } from "@cap/database/cloudflare/atomic";
import { AtomicConflictError } from "@cap/database/cloudflare/atomic";
import {
	comments,
	videoEdits,
	videos,
	videoUploads,
} from "@cap/database/cloudflare/schema";
import {
	discardTranscriptPreparation,
	metadataWithTranscriptPublication,
	prepareTranscriptPublication,
	readTranscriptArtifacts,
	readTranscriptPublicationOutcome,
	type TranscriptObjectStore,
	TranscriptPublicationConflictError,
} from "@cap/database/cloudflare/transcript-publication";
import type {
	VideoEditRange,
	VideoEditSpec,
	VideoMetadata,
} from "@cap/database/types";
import { serverEnv } from "@cap/env";
import { AwsCredentials } from "@cap/web-backend/src/Aws";
import { Storage } from "@cap/web-backend/src/Storage/index";
import { Video } from "@cap/web-domain";
import { eq } from "drizzle-orm";
import { Effect, Option } from "effect";
import { FatalError, sleep } from "workflow";
import { retireDesktopRecordingJobForOutputReplacement } from "@/lib/desktop-recording-jobs";
import {
	type EditTranscript,
	editTranscriptWordsToCaptionVtt,
	parseEditTranscript,
	remapEditTranscriptThroughSpec,
} from "@/lib/edit-transcript";
import { startAiGeneration } from "@/lib/generate-ai";
import { transcribeVideo } from "@/lib/transcribe";
import { remapCommentTimestamps } from "@/lib/video-edit-comment-remap";
import {
	clearFailedEdit,
	type EditOperation,
	getCompletedEdit,
	getEditOutputKeys,
	getEditProcessingState,
	matchesEditOperation,
	withEditOperation,
	withoutEditProcessing,
} from "@/lib/video-edit-operation";
import {
	getEditSpecOutputDuration,
	remapCurrentOutputTimeThroughEdit,
} from "@/lib/video-edits";
import { normalizeVideoFps } from "@/lib/video-metadata";
import { decodeStorageVideo } from "@/lib/video-storage";
import { runWorkflowPromise } from "@/lib/workflow-runtime";

interface EditVideoWorkflowPayload {
	videoId: string;
	userId: string;
	sourceKey: string;
	previousSpec: VideoEditSpec;
	editSpec: VideoEditSpec;
	keepRanges: VideoEditRange[];
	aiGenerationEnabled: boolean;
	operation: EditOperation;
}

interface VideoEditRenderResult {
	metadata: {
		duration: number;
		width: number;
		height: number;
		fps: number;
	};
}

const MEDIA_SERVER_COMPLETION_MAX_ATTEMPTS = 720;
const MEDIA_SERVER_DISPATCH_TIMEOUT_MS = 30_000;
const MEDIA_SERVER_PRESIGNED_GET_EXPIRES_SECONDS = 3 * 60 * 60;
const MEDIA_SERVER_PRESIGNED_PUT_EXPIRES_SECONDS = 3 * 60 * 60;
const MEDIA_SERVER_OUTPUT_VERIFICATION_MAX_ATTEMPTS = 4;
const MEDIA_SERVER_OUTPUT_VERIFICATION_RETRY_MS = 1000;
const EDIT_TRANSCRIPT_CURRENCY_TOLERANCE_MS = 250;

function getValidDuration(duration: number) {
	return Number.isFinite(duration) && duration > 0 ? duration : undefined;
}

async function waitForRetry(delayMs: number): Promise<void> {
	await new Promise((resolve) => setTimeout(resolve, delayMs));
}

function getDurationTolerance(duration: number) {
	if (!Number.isFinite(duration) || duration <= 0) return 0.5;
	return Math.max(0.5, Math.min(5, duration * 0.01));
}

function isDurationClose(actual: number, expected: number) {
	return (
		Number.isFinite(actual) &&
		Number.isFinite(expected) &&
		Math.abs(actual - expected) <= getDurationTolerance(expected)
	);
}

export async function editVideoWorkflow(
	payload: EditVideoWorkflowPayload,
): Promise<VideoEditRenderResult> {
	"use workflow";

	const {
		videoId,
		userId,
		sourceKey,
		previousSpec,
		editSpec,
		aiGenerationEnabled,
		operation,
	} = payload;

	try {
		await validateEditRequest(videoId, sourceKey, operation);
		let capacityRetryCount = 0;
		while (true) {
			const dispatch = await renderVideoEditOnMediaServer(payload);
			if (dispatch.status === "capacity") {
				await markEditWaitingForCapacity(videoId, sourceKey, operation);
				await sleep(`${Math.min(120, 15 + capacityRetryCount * 15)}s`);
				capacityRetryCount++;
				continue;
			}
			if (dispatch.status === "rejected")
				throw new FatalError(dispatch.message);
			break;
		}
		let result: VideoEditRenderResult | undefined;
		for (
			let attempt = 0;
			attempt < MEDIA_SERVER_COMPLETION_MAX_ATTEMPTS;
			attempt++
		) {
			await sleep("5s");
			result = await readEditCompletion(videoId, sourceKey, operation);
			if (result) break;
		}
		if (!result)
			throw new FatalError(
				"Video edit timed out. Your previous video is preserved; please try again.",
			);
		await verifyRenderedEditOutput(
			videoId,
			userId,
			editSpec,
			result.metadata,
			operation,
		);
		await invalidateEditedVideoCache(videoId, editSpec);
		const { transcriptRemapped } = await saveEditResultAndComplete(
			videoId,
			sourceKey,
			previousSpec,
			editSpec,
			result.metadata,
			operation,
		);

		if (transcriptRemapped) {
			// Captions were derived from the immutable word transcript, so the
			// transcription stays COMPLETE and no new paid pass is needed.
			if (aiGenerationEnabled) {
				await queueAiGeneration(videoId, userId);
			}
		} else {
			await queueTranscriptionRegeneration(
				videoId,
				userId,
				aiGenerationEnabled,
			);
		}

		return result;
	} catch (error) {
		const errorMessage = error instanceof Error ? error.message : String(error);
		if (operation)
			await clearEditProcessingState(videoId, sourceKey, operation);
		throw new FatalError(errorMessage);
	}
}

async function validateEditRequest(
	videoId: string,
	sourceKey: string,
	operation: EditOperation,
): Promise<void> {
	"use step";

	if (!serverEnv().MEDIA_SERVER_URL) {
		throw new FatalError("MEDIA_SERVER_URL is not configured");
	}
	if (
		!operation ||
		!operation.token ||
		!Number.isFinite(Date.parse(operation.startedAt))
	) {
		throw new FatalError("Edit operation identity is missing");
	}

	const [video] = await db()
		.select()
		.from(videos)
		.where(eq(videos.id, videoId as Video.VideoId));

	if (!video) {
		throw new FatalError("Video does not exist");
	}

	const [upload] = await db()
		.select()
		.from(videoUploads)
		.where(eq(videoUploads.videoId, videoId as Video.VideoId));

	if (!upload) {
		throw new FatalError("Edit render does not exist");
	}

	if (!matchesEditOperation(video, upload, sourceKey, operation)) {
		throw new FatalError("Edit operation has been replaced");
	}

	if (upload.phase !== "processing") {
		throw new FatalError("Video is not ready for edit rendering");
	}
}

type EditDispatch =
	| { status: "accepted" | "capacity" }
	| { status: "rejected"; message: string };

export async function startMediaServerEditJob(
	mediaServerUrl: string,
	body: { videoId: string; webhookSecret?: string; [key: string]: unknown },
): Promise<EditDispatch & { jobId?: string }> {
	const response = await fetch(`${mediaServerUrl}/video/edit`, {
		method: "POST",
		headers: {
			"Content-Type": "application/json",
			...(body.webhookSecret
				? { "x-media-server-secret": body.webhookSecret }
				: {}),
		},
		body: JSON.stringify(body),
		signal: AbortSignal.timeout(MEDIA_SERVER_DISPATCH_TIMEOUT_MS),
	});
	const data: unknown = await response.json();
	const value = data && typeof data === "object" ? data : {};
	if (response.ok && "jobId" in value && typeof value.jobId === "string") {
		return { status: "accepted", jobId: value.jobId };
	}
	if (
		response.status === 503 &&
		"code" in value &&
		value.code === "SERVER_BUSY"
	)
		return { status: "capacity" };
	if (
		response.status === 400 &&
		"code" in value &&
		value.code === "INVALID_REQUEST"
	) {
		return {
			status: "rejected",
			message: "The media server rejected the edit request",
		};
	}
	throw new Error("The media server acceptance is uncertain");
}

async function renderVideoEditOnMediaServer(
	payload: EditVideoWorkflowPayload,
): Promise<EditDispatch> {
	"use step";

	const { videoId, userId, sourceKey, keepRanges, operation } = payload;
	const mediaServerUrl = serverEnv().MEDIA_SERVER_URL;
	const webhookBaseUrl =
		serverEnv().MEDIA_SERVER_WEBHOOK_URL || serverEnv().WEB_URL;
	if (!mediaServerUrl) {
		throw new FatalError("MEDIA_SERVER_URL is not configured");
	}

	const current = await withEditOperation(
		videoId,
		sourceKey,
		operation,
		async (_database, _snapshot, video, _upload, state) => ({
			statements: [],
			result: { video, dispatch: state.dispatch },
		}),
	);
	if (current.dispatch !== "pending") return { status: "accepted" };
	const video = current.video;

	const [bucket] = await Storage.getAccessForVideo(
		decodeStorageVideo(video),
	).pipe(runWorkflowPromise);

	const sourceUrl = await bucket
		.getInternalSignedObjectUrl(sourceKey, {
			expiresIn: MEDIA_SERVER_PRESIGNED_GET_EXPIRES_SECONDS,
		})
		.pipe(runWorkflowPromise);

	const {
		outputKey,
		thumbnailKey,
		previewKey: previewGifKey,
	} = getEditOutputKeys(userId, videoId, operation);

	const outputPresignedUrl = await bucket
		.getInternalPresignedPutUrl(
			outputKey,
			{
				ContentType: "video/mp4",
			},
			{ expiresIn: MEDIA_SERVER_PRESIGNED_PUT_EXPIRES_SECONDS },
		)
		.pipe(runWorkflowPromise);

	const [outputBucket] = await Storage.getAccessForVideo(
		decodeStorageVideo(video),
		{ resolvePublishedOutput: false },
	).pipe(runWorkflowPromise);
	const outputVerificationUrl = await outputBucket
		.getInternalSignedObjectUrl(outputKey, {
			expiresIn: MEDIA_SERVER_PRESIGNED_GET_EXPIRES_SECONDS,
		})
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

	const webhookUrl = new URL(
		"/api/webhooks/media-server/progress",
		webhookBaseUrl,
	);
	webhookUrl.searchParams.set("editOperation", operation.token);
	webhookUrl.searchParams.set("editStartedAt", operation.startedAt);
	const webhookSecret = serverEnv().MEDIA_SERVER_WEBHOOK_SECRET;
	const claimed = await withEditOperation(
		videoId,
		sourceKey,
		operation,
		async (database, _snapshot, current, upload, state) => {
			const statements: AtomicStatement[] = [];
			if (state.dispatch !== "pending") return { statements, result: false };
			if (upload.phase !== "processing")
				throw new FatalError("Edit is no longer waiting for dispatch");
			statements.push(
				database
					.update(videos)
					.set({
						metadata: {
							...current.metadata,
							editProcessing: { ...state, dispatch: "dispatching" },
						},
					})
					.where(eq(videos.id, current.id)),
			);
			return { statements, result: true };
		},
	);
	if (!claimed) return { status: "accepted" };
	let dispatch: EditDispatch & { jobId?: string };
	try {
		dispatch = await startMediaServerEditJob(mediaServerUrl, {
			videoId,
			userId,
			sourceUrl,
			outputPresignedUrl,
			outputVerificationUrl,
			thumbnailPresignedUrl,
			previewGifPresignedUrl,
			webhookUrl: webhookUrl.toString(),
			webhookSecret: webhookSecret || undefined,
			keepRanges,
		});
	} catch {
		return { status: "accepted" };
	}
	await withEditOperation(
		videoId,
		sourceKey,
		operation,
		async (database, _snapshot, current, _upload, state) => {
			const statements: AtomicStatement[] = [];
			if (state.dispatch !== "dispatching")
				return { statements, result: undefined };
			statements.push(
				database
					.update(videos)
					.set({
						metadata: {
							...current.metadata,
							editProcessing: {
								...state,
								dispatch:
									dispatch.status === "accepted" ? "accepted" : "pending",
								...(dispatch.jobId ? { jobId: dispatch.jobId } : {}),
							},
						},
					})
					.where(eq(videos.id, current.id)),
			);
			return { statements, result: undefined };
		},
	);
	return dispatch;
}

async function markEditWaitingForCapacity(
	videoId: string,
	sourceKey: string,
	operation: EditOperation,
): Promise<void> {
	"use step";
	const mutationTime = new Date();
	await withEditOperation(
		videoId,
		sourceKey,
		operation,
		async (database, _snapshot, video) => {
			const statements: AtomicStatement[] = [];
			statements.push(
				database
					.update(videoUploads)
					.set({
						processingMessage: "Queued for video editing...",
						processingError: null,
						updatedAt: mutationTime,
					})
					.where(eq(videoUploads.videoId, video.id)),
			);
			return { statements, result: undefined };
		},
	);
}

async function probeVideoOnMediaServer(
	mediaServerUrl: string,
	videoUrl: string,
	webhookSecret: string | undefined,
): Promise<VideoEditRenderResult["metadata"]> {
	const headers: Record<string, string> = {
		"Content-Type": "application/json",
	};
	if (webhookSecret) {
		headers["x-media-server-secret"] = webhookSecret;
	}

	const response = await fetch(`${mediaServerUrl}/video/probe`, {
		method: "POST",
		headers,
		body: JSON.stringify({ videoUrl }),
	});

	if (!response.ok) {
		const errorData = (await response.json().catch(() => ({}))) as {
			error?: string;
			details?: string;
		};
		throw new Error(
			errorData.error || errorData.details || "Rendered video probe failed",
		);
	}

	const { metadata } = (await response.json()) as VideoEditRenderResult;
	return metadata;
}

export async function verifyRenderedEditOutput(
	videoId: string,
	userId: string,
	editSpec: VideoEditSpec,
	reportedMetadata: VideoEditRenderResult["metadata"],
	operation?: EditOperation,
): Promise<void> {
	"use step";

	const expectedDuration = getEditSpecOutputDuration(editSpec);
	if (!isDurationClose(reportedMetadata.duration, expectedDuration)) {
		throw new Error(
			`Media server reported edited duration ${reportedMetadata.duration.toFixed(3)}s, expected ${expectedDuration.toFixed(3)}s`,
		);
	}

	const mediaServerUrl = serverEnv().MEDIA_SERVER_URL;
	if (!mediaServerUrl) {
		throw new FatalError("MEDIA_SERVER_URL is not configured");
	}

	const [video] = await db()
		.select()
		.from(videos)
		.where(eq(videos.id, Video.VideoId.make(videoId)));

	if (!video) {
		throw new FatalError("Video does not exist");
	}

	const [bucket] = await Storage.getAccessForVideo(decodeStorageVideo(video), {
		resolvePublishedOutput: false,
	}).pipe(runWorkflowPromise);
	const outputKey = operation
		? getEditOutputKeys(userId, videoId, operation).outputKey
		: `${userId}/${videoId}/result.mp4`;
	const outputUrl = await bucket
		.getInternalSignedObjectUrl(outputKey, {
			expiresIn: MEDIA_SERVER_PRESIGNED_GET_EXPIRES_SECONDS,
		})
		.pipe(runWorkflowPromise);

	let lastError: Error | undefined;

	for (
		let attempt = 0;
		attempt < MEDIA_SERVER_OUTPUT_VERIFICATION_MAX_ATTEMPTS;
		attempt++
	) {
		try {
			const actualMetadata = await probeVideoOnMediaServer(
				mediaServerUrl,
				outputUrl,
				serverEnv().MEDIA_SERVER_WEBHOOK_SECRET || undefined,
			);
			if (isDurationClose(actualMetadata.duration, expectedDuration)) {
				return;
			}

			lastError = new Error(
				`Rendered video duration mismatch: expected ${expectedDuration.toFixed(3)}s, got ${actualMetadata.duration.toFixed(3)}s`,
			);
		} catch (error) {
			lastError = error instanceof Error ? error : new Error(String(error));
		}

		if (attempt < MEDIA_SERVER_OUTPUT_VERIFICATION_MAX_ATTEMPTS - 1) {
			await waitForRetry(
				MEDIA_SERVER_OUTPUT_VERIFICATION_RETRY_MS * (attempt + 1),
			);
		}
	}

	throw lastError ?? new Error("Rendered video verification failed");
}

function clearAiMetadata(metadata: VideoMetadata | null): VideoMetadata {
	const nextMetadata = { ...(metadata ?? {}) };
	delete nextMetadata.summary;
	delete nextMetadata.chapters;
	delete nextMetadata.aiGenerationStatus;
	return nextMetadata;
}

async function queueAiGeneration(
	videoId: string,
	userId: string,
): Promise<void> {
	"use step";

	try {
		const result = await startAiGeneration(videoId as Video.VideoId, userId);

		if (!result.success) {
			console.warn("[editVideoWorkflow] Failed to queue AI generation", {
				videoId,
				message: result.message,
			});
		}
	} catch (error) {
		console.warn("[editVideoWorkflow] Failed to queue AI generation", error);
	}
}

async function queueTranscriptionRegeneration(
	videoId: string,
	userId: string,
	aiGenerationEnabled: boolean,
): Promise<void> {
	"use step";

	try {
		const result = await transcribeVideo(
			videoId as Video.VideoId,
			userId,
			aiGenerationEnabled,
		);

		if (!result.success) {
			console.warn("[editVideoWorkflow] Failed to queue transcription", {
				videoId,
				message: result.message,
			});
		}
	} catch (error) {
		console.warn("[editVideoWorkflow] Failed to queue transcription", error);
	}
}

async function getTranscriptStore(
	video: typeof videos.$inferSelect,
): Promise<TranscriptObjectStore> {
	const [bucket] = await Storage.getAccessForVideo(
		decodeStorageVideo(video),
	).pipe(runWorkflowPromise);
	return {
		getText: async (key) =>
			Option.getOrNull(await bucket.getObject(key).pipe(runWorkflowPromise)),
		put: (key, text, contentType) =>
			bucket.putObject(key, text, { contentType }).pipe(runWorkflowPromise),
		delete: (key) => bucket.deleteObject(key).pipe(runWorkflowPromise),
	};
}

async function loadOriginalEditTranscript(
	video: typeof videos.$inferSelect,
	editSpec: VideoEditSpec,
	store: TranscriptObjectStore,
) {
	const artifacts = await readTranscriptArtifacts(video, store);
	const transcript = artifacts.editTranscript
		? parseEditTranscript(artifacts.editTranscript)
		: null;
	if (!transcript) return null;
	const expectedDurationMs = Math.round(editSpec.sourceDuration * 1000);
	return Math.abs(transcript.durationMs - expectedDurationMs) <=
		EDIT_TRANSCRIPT_CURRENCY_TOLERANCE_MS
		? transcript
		: null;
}

async function readEditCompletion(
	videoId: string,
	sourceKey: string,
	operation: EditOperation,
): Promise<VideoEditRenderResult | undefined> {
	"use step";
	return withEditOperation(
		videoId,
		sourceKey,
		operation,
		async (_database, _snapshot, _video, upload, state) => {
			const statements: AtomicStatement[] = [];
			if (upload.phase === "complete") {
				const metadata = state.renderedMetadata;
				if (!metadata)
					throw new FatalError("Edit completed but video metadata is missing");
				return { statements, result: { metadata } };
			}
			if (upload.phase === "error" || upload.processingError)
				throw new FatalError(
					upload.processingError ||
						upload.processingMessage ||
						"Video edit failed",
				);
			return { statements, result: undefined };
		},
	);
}

function getEditInvalidationCallerReference(
	videoId: string,
	editSpec: VideoEditSpec,
) {
	const editHash = createHash("sha256")
		.update(JSON.stringify(editSpec))
		.digest("hex")
		.slice(0, 16);
	return `edit-${videoId}-${editHash}`;
}

async function invalidateEditedVideoCache(
	videoId: string,
	editSpec: VideoEditSpec,
): Promise<void> {
	"use step";

	const distributionId = serverEnv().CAP_CLOUDFRONT_DISTRIBUTION_ID;
	if (!distributionId) return;

	const [video] = await db()
		.select({
			ownerId: videos.ownerId,
			bucket: videos.bucket,
		})
		.from(videos)
		.where(eq(videos.id, videoId as Video.VideoId));

	if (!video || video.bucket) return;

	const basePath = `/${video.ownerId}/${videoId}`;
	const paths = [
		`${basePath}/result.mp4`,
		`${basePath}/screenshot/screen-capture.jpg`,
		`${basePath}/preview/animated-preview.gif`,
	];

	try {
		const cloudfront = new CloudFrontClient({
			region: serverEnv().CAP_AWS_REGION || "us-east-1",
			credentials: await runWorkflowPromise(
				Effect.map(AwsCredentials, (credentials) => credentials.credentials),
			),
		});

		await cloudfront.send(
			new CreateInvalidationCommand({
				DistributionId: distributionId,
				InvalidationBatch: {
					CallerReference: getEditInvalidationCallerReference(
						videoId,
						editSpec,
					),
					Paths: {
						Quantity: paths.length,
						Items: paths,
					},
				},
			}),
		);
	} catch (error) {
		console.warn(
			"[editVideoWorkflow] Failed to invalidate edited video cache",
			{
				error,
				videoId,
			},
		);
	}
}

export async function saveEditResultAndComplete(
	videoId: string,
	sourceKey: string,
	previousSpec: VideoEditSpec,
	editSpec: VideoEditSpec,
	metadata: { duration: number; width: number; height: number; fps: number },
	operation: EditOperation,
): Promise<{ transcriptRemapped: boolean }> {
	"use step";

	const duration = getValidDuration(metadata.duration);
	const [video] = await db()
		.select()
		.from(videos)
		.where(eq(videos.id, videoId as Video.VideoId));

	if (!video) {
		throw new FatalError("Video does not exist");
	}

	const completed = getCompletedEdit(video.metadata);
	if (
		completed?.token === operation.token &&
		completed.startedAt === operation.startedAt
	) {
		return { transcriptRemapped: completed.transcriptRemapped };
	}

	if (getEditProcessingState(video.metadata)?.resultCommitted) {
		const transcriptRemapped =
			video.metadata?.transcriptPublication?.vtt === true;
		await completeEditProcessing(
			videoId,
			sourceKey,
			operation,
			transcriptRemapped,
		);
		return { transcriptRemapped };
	}
	const transcriptStore = await getTranscriptStore(video);
	let originalTranscript: EditTranscript | null = null;
	try {
		originalTranscript = await loadOriginalEditTranscript(
			video,
			editSpec,
			transcriptStore,
		);
	} catch (error) {
		console.warn(
			"[editVideoWorkflow] Failed to load stored edit transcript",
			error,
		);
	}
	const preparedTranscript = await prepareTranscriptPublication({
		video,
		store: transcriptStore,
		vtt: originalTranscript
			? editTranscriptWordsToCaptionVtt(
					remapEditTranscriptThroughSpec(originalTranscript, editSpec).words,
				)
			: null,
		editTranscript: originalTranscript
			? JSON.stringify(originalTranscript)
			: null,
	});
	const retirement = retireDesktopRecordingJobForOutputReplacement(db(), {
		videoId: video.id,
		userId: video.ownerId,
	});
	const mutationTime = new Date();
	let committed: { publicationCommitted: boolean; transcriptRemapped: boolean };
	try {
		committed = await withEditOperation<{
			publicationCommitted: boolean;
			transcriptRemapped: boolean;
		}>(
			videoId,
			sourceKey,
			operation,
			async (database, snapshot, lockedVideo, upload, state) => {
				const statements: AtomicStatement[] = [];
				if (upload.phase !== "complete")
					throw new FatalError("Edit output is not complete");
				if (state.resultCommitted)
					return {
						statements,
						result: {
							publicationCommitted: false,
							transcriptRemapped:
								lockedVideo.metadata?.transcriptPublication?.vtt === true,
						},
					};
				statements.push(retirement);
				const source = {
					...lockedVideo.source,
					...getEditOutputKeys(lockedVideo.ownerId, videoId, operation),
				};
				if (source.type === "desktopMP4" || source.type === "webMP4") {
					delete source.audioLevelSourceKey;
					delete source.audioLevelOutputKey;
				}
				const nextMetadata = clearAiMetadata(lockedVideo.metadata);
				delete nextMetadata.desktopRecordingUpload;
				statements.push(
					database
						.update(videos)
						.set({
							source,
							width: metadata.width,
							height: metadata.height,
							fps: normalizeVideoFps(metadata.fps),
							metadata: metadataWithTranscriptPublication(
								lockedVideo,
								preparedTranscript,
								{
									...nextMetadata,
									editProcessing: {
										...state,
										source: JSON.stringify(source),
										resultCommitted: true,
									},
								},
							),
							// Derivable captions keep the transcription COMPLETE; only legacy
							// videos without a stored word transcript get re-transcribed.
							...(originalTranscript ? {} : { transcriptionStatus: null }),
							...(duration === undefined ? {} : { duration }),
						})
						.where(eq(videos.id, videoId as Video.VideoId)),
				);

				statements.push(
					database
						.insert(videoEdits)
						.values({
							videoId: videoId as Video.VideoId,
							sourceKey,
							editSpec,
							updatedAt: mutationTime,
						})
						.onConflictDoUpdate({
							target: videoEdits.videoId,
							set: {
								sourceKey,
								editSpec,
								updatedAt: mutationTime,
							},
						}),
				);

				const timestampedComments = await snapshot.read((reader) =>
					reader
						.select({
							id: comments.id,
							timestamp: comments.timestamp,
						})
						.from(comments)
						.where(eq(comments.videoId, videoId as Video.VideoId)),
				);

				const changes = timestampedComments.flatMap((comment) => {
					if (comment.timestamp === null) return [];
					const timestamp = remapCurrentOutputTimeThroughEdit(
						comment.timestamp,
						previousSpec,
						editSpec,
					);
					return timestamp === comment.timestamp
						? []
						: [{ id: comment.id, timestamp }];
				});
				if (changes.length > 0)
					statements.push(
						remapCommentTimestamps(
							database,
							videoId as Video.VideoId,
							changes,
							mutationTime,
						),
					);
				return {
					statements,
					result: {
						publicationCommitted: true,
						transcriptRemapped: originalTranscript !== null,
					},
				};
			},
		);
	} catch (error) {
		const outcome = await readTranscriptPublicationOutcome(
			db(),
			preparedTranscript,
		).catch(() => null);
		if (outcome?.state === "published")
			committed = {
				publicationCommitted: true,
				transcriptRemapped: originalTranscript !== null,
			};
		else {
			if (
				error instanceof TranscriptPublicationConflictError ||
				error instanceof AtomicConflictError ||
				error instanceof FatalError
			) {
				await discardTranscriptPreparation(
					preparedTranscript,
					transcriptStore,
					{ commit: "rolled-back" },
				).catch((cleanupError) =>
					console.warn("Edit transcript preparation cleanup failed", {
						videoId,
						cleanupError,
					}),
				);
			}
			throw error;
		}
	}
	if (!committed.publicationCommitted)
		await discardTranscriptPreparation(preparedTranscript, transcriptStore, {
			commit: "not-attempted",
		});
	const transcriptRemapped = committed.transcriptRemapped;
	await completeEditProcessing(
		videoId,
		sourceKey,
		operation,
		transcriptRemapped,
	);
	return { transcriptRemapped };
}

async function completeEditProcessing(
	videoId: string,
	sourceKey: string,
	operation: EditOperation,
	transcriptRemapped: boolean,
) {
	await withEditOperation(
		videoId,
		sourceKey,
		operation,
		async (database, _snapshot, video, upload, state) => {
			const statements: AtomicStatement[] = [];
			if (!state.resultCommitted || upload.phase !== "complete")
				throw new FatalError("Edit result has not been committed");
			statements.push(
				database
					.update(videos)
					.set({
						metadata: {
							...withoutEditProcessing(video.metadata),
							completedVideoEdit: { ...operation, transcriptRemapped },
						},
					})
					.where(eq(videos.id, video.id)),
			);
			statements.push(
				database.delete(videoUploads).where(eq(videoUploads.videoId, video.id)),
			);
			return { statements, result: undefined };
		},
	);
}

async function clearEditProcessingState(
	videoId: string,
	sourceKey: string,
	operation: EditOperation,
): Promise<void> {
	"use step";
	await clearFailedEdit(videoId, sourceKey, operation);
}
