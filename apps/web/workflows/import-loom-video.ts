import {
	requireOrganizationManager,
	requireOrganizationMember,
} from "@cap/database/cloudflare/access";
import { db } from "@cap/database/cloudflare/application";
import { type AtomicSnapshot, atomic } from "@cap/database/cloudflare/atomic";
import {
	agentApiOperations,
	s3Buckets,
	storageIntegrations,
	videos,
	videoUploads,
} from "@cap/database/cloudflare/schema";
import { serverEnv } from "@cap/env";
import { Storage } from "@cap/web-backend/src/Storage/index";
import { Video } from "@cap/web-domain";
import { and, eq } from "drizzle-orm";
import { Effect } from "effect";
import {
	createHook,
	FatalError,
	getWorkflowMetadata,
	RetryableError,
	sleep,
} from "workflow";
import {
	getLoomDownloadUrl,
	getReusableLoomDownloadUrl,
	LoomDownloadTemporaryError,
} from "@/lib/loom-download-url";
import { cleanupLoomFileSource } from "@/lib/loom-file-cleanup";
import {
	getLoomImportArtifactKeys,
	loomImportSourcePublication,
} from "@/lib/loom-import-artifacts";
import { getLoomImportSignalToken } from "@/lib/loom-import-signal-token";
import {
	ensureLoomImportWorkflow,
	ownsLoomImportSource,
	readLoomImportVideo,
} from "@/lib/loom-import-state";
import {
	LOOM_IMPORT_MAX_BYTES,
	type LoomMultipartUploadTarget,
	prepareLoomMultipartUploads,
} from "@/lib/loom-import-upload";
import {
	isLoomMediaJobFailed,
	recordLoomMediaDispatch,
} from "@/lib/loom-media-dispatch";
import {
	createMediaServerCapacityError,
	isMediaServerCapacityError,
} from "@/lib/media-server-backpressure";
import { isStorageObjectNotFound } from "@/lib/storage-not-found";
import { normalizeVideoFps } from "@/lib/video-metadata";
import { runWorkflowPromise } from "@/lib/workflow-runtime";
import {
	type ProcessedVideoMetadata,
	VideoProcessingFailedError,
	waitForSignalledVideoProcessing,
} from "./video-processing-status";

interface ImportLoomPayload {
	videoId: string;
	userId: string;
	rawFileKey: string;
	bucketId: string | null;
	loomVideoId: string;
	loomDownloadUrl?: string;
	agentOperationId?: string;
	reuseExistingRawUpload?: boolean;
	cleanupRawUpload?: boolean;
	importPriority?: "customer" | "bulk";
}

const MINIMUM_VIDEO_SIZE = 1024;
const MEDIA_SERVER_START_MAX_ATTEMPTS = 2;
const MEDIA_SERVER_START_RETRY_BASE_MS = 250;
const MEDIA_SERVER_PRESIGNED_GET_EXPIRES_SECONDS = 3 * 60 * 60;
const MEDIA_SERVER_PRESIGNED_PUT_EXPIRES_SECONDS = 3 * 60 * 60;

function getValidDuration(duration: number) {
	return Number.isFinite(duration) && duration > 0 ? duration : undefined;
}

function isStreamingUrl(url: string): boolean {
	const path = (url.split("?")[0] ?? "").toLowerCase();
	return path.endsWith(".m3u8") || path.endsWith(".mpd");
}

function isMp4Url(url: string): boolean {
	return (url.split("?")[0] ?? "").toLowerCase().endsWith(".mp4");
}

type LoomWorker = "importer" | "media";

function getLoomWorkerUrl(worker: LoomWorker): string | undefined {
	const env = serverEnv();
	return worker === "importer" ? env.LOOM_IMPORTER_URL : env.MEDIA_SERVER_URL;
}

async function fetchFreshLoomDownloadUrl(
	loomVideoId: string,
	existingUrl?: string,
): Promise<string> {
	"use step";

	const reusableUrl = getReusableLoomDownloadUrl(existingUrl);
	if (reusableUrl) return reusableUrl;
	try {
		const url = await getLoomDownloadUrl(loomVideoId);
		if (url) return url;
	} catch (error) {
		if (error instanceof LoomDownloadTemporaryError) {
			throw new RetryableError(error.message, {
				retryAfter: error.retryAfterMs,
			});
		}
		throw error;
	}
	throw new FatalError(
		"Could not retrieve a download URL from Loom. The video may be private, password-protected, or the link may have expired.",
	);
}

fetchFreshLoomDownloadUrl.maxRetries = 8;

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

interface LoomProcessingInput {
	importFromLoom?: boolean;
	rawFileKey?: string;
}

async function requireLoomMediaServerSupport() {
	"use step";

	const env = serverEnv();
	if (!env.MEDIA_SERVER_URL)
		throw new FatalError("MEDIA_SERVER_URL is not configured");
	await requireLoomWorkerCapabilities(env.MEDIA_SERVER_URL);
	if (env.LOOM_IMPORTER_URL)
		await requireLoomWorkerCapabilities(env.LOOM_IMPORTER_URL);
}

requireLoomMediaServerSupport.maxRetries = 60;

async function requireLoomWorkerCapabilities(workerUrl: string) {
	const env = serverEnv();
	const response = await fetch(`${workerUrl}/video/status`, {
		headers: env.MEDIA_SERVER_WEBHOOK_SECRET
			? { "x-media-server-secret": env.MEDIA_SERVER_WEBHOOK_SECRET }
			: undefined,
		signal: AbortSignal.timeout(15_000),
	});
	if (!response.ok)
		throw new RetryableError(
			"Could not verify Loom import worker capabilities",
			{ retryAfter: 60_000 },
		);
	const capabilities: unknown = await response.json();
	if (
		typeof capabilities !== "object" ||
		capabilities === null ||
		!("loomMultipartUploads" in capabilities) ||
		capabilities.loomMultipartUploads !== true ||
		!("loomImportMaxBytes" in capabilities) ||
		capabilities.loomImportMaxBytes !== LOOM_IMPORT_MAX_BYTES
	) {
		throw new RetryableError(
			"The media server must be updated for 10 GB Loom imports",
			{ retryAfter: 60_000 },
		);
	}
}

async function initializeImport(payload: ImportLoomPayload, runId: string) {
	"use step";
	return ensureLoomImportWorkflow(db(), payload, runId);
}

async function claimAgentImport(payload: ImportLoomPayload) {
	"use step";
	if (!payload.agentOperationId) return true;
	const database = db();
	return atomic(database, async (snapshot) => {
		const video = await readLoomImportVideo(snapshot, payload);
		const [operation] = await snapshot.read((reader) =>
			reader
				.select()
				.from(agentApiOperations)
				.where(eq(agentApiOperations.id, payload.agentOperationId as string))
				.limit(1),
		);
		if (
			!operation ||
			operation.kind !== "import_loom" ||
			operation.resultResourceId !== payload.videoId ||
			operation.resourceId !== video.orgId
		)
			throw new FatalError("Agent Loom import operation not found");
		if (operation.state !== "queued") return { statements: [], result: false };
		if (operation.userId === video.ownerId)
			await requireOrganizationMember(snapshot, video.orgId, operation.userId);
		else
			await requireOrganizationManager(snapshot, video.orgId, operation.userId);
		return {
			statements: [
				database
					.update(agentApiOperations)
					.set({ state: "running", updatedAt: new Date() })
					.where(eq(agentApiOperations.id, operation.id)),
			],
			result: true,
		};
	});
}

async function completeAgentImport(
	operationId: string | undefined,
	videoId: string,
) {
	"use step";

	if (!operationId) return;
	const now = new Date();
	await db()
		.update(agentApiOperations)
		.set({
			state: "succeeded",
			result: { videoId },
			updatedAt: now,
			completedAt: now,
		})
		.where(
			and(
				eq(agentApiOperations.id, operationId),
				eq(agentApiOperations.state, "running"),
			),
		);
}

async function failAgentImport(
	operationId: string | undefined,
	message: string,
) {
	"use step";

	if (!operationId) return;
	const now = new Date();
	await db()
		.update(agentApiOperations)
		.set({
			state: "failed",
			errorCode: "LOOM_IMPORT_FAILED",
			errorMessage: message.slice(0, 2_000),
			updatedAt: now,
			completedAt: now,
		})
		.where(
			and(
				eq(agentApiOperations.id, operationId),
				eq(agentApiOperations.state, "running"),
			),
		);
}

export async function importLoomVideoWorkflow(
	payload: ImportLoomPayload,
): Promise<VideoProcessingResult> {
	"use workflow";

	const { workflowRunId } = getWorkflowMetadata();
	if (!(await claimAgentImport(payload))) {
		return { success: true, message: "Loom import is already running" };
	}
	try {
		await initializeImport(payload, workflowRunId);
		const savedInput = payload.reuseExistingRawUpload
			? await findExistingLoomInput(payload, workflowRunId)
			: null;
		let processingInput: LoomProcessingInput = savedInput
			? { rawFileKey: savedInput }
			: { importFromLoom: true };
		let optimizedInputKey: string | undefined;
		await requireLoomMediaServerSupport();

		let metadata: ProcessedVideoMetadata;
		for (let processingAttempt = 0; ; processingAttempt++) {
			const finished = createHook<{ phase: string }>({
				token: getLoomImportSignalToken(
					payload.videoId,
					`${workflowRunId}:${processingAttempt}`,
				),
			});
			try {
				let mediaJob: { jobId: string; worker: LoomWorker };
				let capacityRetryCount = 0;
				let previousSourceUrl =
					processingAttempt === 0 ? payload.loomDownloadUrl : undefined;
				while (true) {
					try {
						const loomSourceUrl = processingInput.importFromLoom
							? await fetchFreshLoomDownloadUrl(
									payload.loomVideoId,
									previousSourceUrl,
								)
							: undefined;
						previousSourceUrl = loomSourceUrl;
						mediaJob = await processVideoOnMediaServer(
							payload,
							loomSourceUrl,
							`${workflowRunId}:${processingAttempt}`,
							workflowRunId,
							processingInput.rawFileKey,
						);
						optimizedInputKey =
							mediaJob.worker === "media"
								? (processingInput.rawFileKey ?? payload.rawFileKey)
								: undefined;
						break;
					} catch (error) {
						if (!isMediaServerCapacityError(error)) throw error;
						await markLoomImportWaitingForCapacity(payload, workflowRunId);
						await sleep(`${Math.min(180, 30 + capacityRetryCount * 15)}s`);
						capacityRetryCount++;
					}
				}
				try {
					metadata = await waitForSignalledVideoProcessing(
						payload.videoId,
						finished,
					);
					break;
				} catch (error) {
					if (
						!(error instanceof VideoProcessingFailedError) ||
						processingAttempt >= 2
					) {
						throw error;
					}
					if (
						!(await confirmLoomMediaJobFailure(
							mediaJob.jobId,
							payload.videoId,
							mediaJob.worker,
						))
					) {
						throw new FatalError(
							"The previous Loom worker must be reconciled before retrying",
						);
					}
					await markLoomImportWaitingForCapacity(payload, workflowRunId);
					const savedInput = await findExistingLoomInput(
						payload,
						workflowRunId,
					);
					if (savedInput) processingInput = { rawFileKey: savedInput };
					await sleep(15_000 * (processingAttempt + 1));
				}
			} finally {
				finished.dispose();
			}
		}
		await saveMetadataAndComplete(
			payload,
			workflowRunId,
			metadata,
			optimizedInputKey,
		);
		await completeAgentImport(payload.agentOperationId, payload.videoId);
		if (payload.cleanupRawUpload) await cleanupLoomFileSource(payload);

		return {
			success: true,
			message: "Loom video imported successfully",
			metadata,
		};
	} catch (error) {
		const errorMessage = error instanceof Error ? error.message : String(error);
		await setProcessingError(payload, workflowRunId, errorMessage);
		await failAgentImport(payload.agentOperationId, errorMessage);
		throw new FatalError(errorMessage);
	}
}

function getInputExtension(url: string): string | undefined {
	const pathname = new URL(url).pathname.toLowerCase();

	if (pathname.endsWith(".m3u8")) {
		return ".m3u8";
	}

	if (pathname.endsWith(".mpd")) {
		return ".mpd";
	}

	if (pathname.endsWith(".mp4")) {
		return ".mp4";
	}

	return undefined;
}

async function confirmLoomMediaJobFailure(
	jobId: string,
	videoId: string,
	worker: LoomWorker,
) {
	"use step";

	return isLoomMediaJobFailed(jobId, videoId, getLoomWorkerUrl(worker));
}

function validLoomInputKey(
	video: typeof videos.$inferSelect,
	key: string | undefined,
): key is string {
	return Boolean(
		key?.startsWith(`${video.ownerId}/${video.id}/`) &&
			!key.includes("..") &&
			/^[A-Za-z0-9_./-]+$/.test(key),
	);
}

function declaredLoomInputKeys(
	video: typeof videos.$inferSelect,
	payload: ImportLoomPayload,
) {
	const receipt = video.metadata?.loomImportUpload;
	const run = video.metadata?.loomImportRun;
	const ownedReceipt =
		receipt &&
		run &&
		receipt.ownerId === video.ownerId &&
		receipt.organizationId === video.orgId &&
		receipt.attemptId.startsWith(`${run.runId}:`) &&
		receipt.output.key ===
			getLoomImportArtifactKeys(video.ownerId, video.id, receipt.attemptId)
				.outputKey &&
		(!receipt.source ||
			receipt.source.key === payload.rawFileKey ||
			receipt.source.key ===
				getLoomImportArtifactKeys(video.ownerId, video.id, receipt.attemptId)
					.originalKey)
			? receipt
			: undefined;
	return [
		...new Set(
			[
				run?.inputKey,
				ownedReceipt?.source?.key,
				video.metadata?.loomDeferredProcessing?.rawFileKey,
				payload.rawFileKey,
				ownedReceipt?.output.key,
			].filter((key) => validLoomInputKey(video, key)),
		),
	];
}

async function readLoomInputStorage(
	snapshot: AtomicSnapshot,
	video: typeof videos.$inferSelect,
) {
	const integrationId = video.storageIntegrationId;
	const bucketId = video.bucket;
	const [integration] = integrationId
		? await snapshot.read((reader) =>
				reader
					.select({
						ownerId: storageIntegrations.ownerId,
						organizationId: storageIntegrations.organizationId,
						status: storageIntegrations.status,
						updatedAt: storageIntegrations.updatedAt,
					})
					.from(storageIntegrations)
					.where(eq(storageIntegrations.id, integrationId))
					.limit(1),
			)
		: [];
	const [bucket] = bucketId
		? await snapshot.read((reader) =>
				reader
					.select({
						ownerId: s3Buckets.ownerId,
						organizationId: s3Buckets.organizationId,
						active: s3Buckets.active,
						updatedAt: s3Buckets.updatedAt,
					})
					.from(s3Buckets)
					.where(eq(s3Buckets.id, bucketId))
					.limit(1),
			)
		: [];
	for (const storage of [integration, bucket]) {
		if (
			storage &&
			(storage.organizationId
				? storage.organizationId !== video.orgId
				: storage.ownerId !== video.ownerId)
		)
			throw new FatalError("Loom input storage ownership changed");
	}
	if (
		(video.storageIntegrationId &&
			(!integration || integration.status !== "active")) ||
		(video.bucket && (!bucket || !bucket.active))
	)
		throw new FatalError("Loom input storage is unavailable");
	return JSON.stringify({
		integration: integration ?? null,
		bucket: bucket ?? null,
	});
}

async function findExistingLoomInput(
	payload: ImportLoomPayload,
	runId: string,
): Promise<string | null> {
	"use step";
	const database = db();
	const captured = await atomic(database, async (snapshot) => {
		const video = await readLoomImportVideo(snapshot, payload);
		if (!ownsLoomImportSource(video, runId))
			throw new FatalError("Loom input was superseded");
		const [upload] = await snapshot.read((reader) =>
			reader
				.select()
				.from(videoUploads)
				.where(eq(videoUploads.videoId, video.id))
				.limit(1),
		);
		return {
			statements: [],
			result: {
				video,
				rawFileKey: upload?.rawFileKey,
				storage: await readLoomInputStorage(snapshot, video),
			},
		};
	});
	const declared = declaredLoomInputKeys(captured.video, payload);
	const candidates = [
		...new Set([
			...(captured.rawFileKey && declared.includes(captured.rawFileKey)
				? [captured.rawFileKey]
				: []),
			...declared,
		]),
	];
	const [bucket] = await Storage.getAccessForVideo(
		Video.Video.decodeSync({
			...captured.video,
			bucketId: captured.video.bucket,
			storageIntegrationId: captured.video.storageIntegrationId,
			createdAt: captured.video.createdAt.toISOString(),
			updatedAt: captured.video.updatedAt.toISOString(),
			metadata: captured.video.metadata,
		}),
	).pipe(runWorkflowPromise);
	for (const key of candidates) {
		const head = await bucket.headObject(key).pipe(
			Effect.catchIf(isStorageObjectNotFound, () => Effect.succeed(null)),
			runWorkflowPromise,
		);
		if (
			!head ||
			!Number.isSafeInteger(head.ContentLength) ||
			(head.ContentLength ?? 0) < MINIMUM_VIDEO_SIZE ||
			(head.ContentLength ?? 0) > LOOM_IMPORT_MAX_BYTES
		)
			continue;
		return atomic(database, async (snapshot) => {
			const video = await readLoomImportVideo(snapshot, payload);
			const run = video.metadata?.loomImportRun;
			const [upload] = await snapshot.read((reader) =>
				reader
					.select()
					.from(videoUploads)
					.where(eq(videoUploads.videoId, video.id))
					.limit(1),
			);
			if (
				!run ||
				!ownsLoomImportSource(video, runId) ||
				(await readLoomInputStorage(snapshot, video)) !== captured.storage ||
				run.sourceRevision !==
					captured.video.metadata?.loomImportRun?.sourceRevision ||
				JSON.stringify(run.mediaDispatch) !==
					JSON.stringify(
						captured.video.metadata?.loomImportRun?.mediaDispatch,
					) ||
				upload?.rawFileKey !== captured.rawFileKey ||
				!declaredLoomInputKeys(video, payload).includes(key)
			)
				throw new FatalError("Loom input changed during storage verification");
			return {
				statements: [
					database
						.update(videos)
						.set({
							metadata: {
								...video.metadata,
								loomImportRun: { ...run, inputKey: key },
							},
						})
						.where(eq(videos.id, video.id)),
				],
				result: key,
			};
		});
	}
	return null;
}

async function waitForRetry(delayMs: number): Promise<void> {
	await new Promise((resolve) => setTimeout(resolve, delayMs));
}

class LoomMediaRequestRejectedError extends Error {}

async function startMediaServerProcessJob(
	mediaServerUrl: string,
	body: {
		videoId: string;
		userId: string;
		videoUrl: string;
		sourcePresignedUrl?: string;
		sourceUpload?: LoomMultipartUploadTarget;
		outputUpload?: LoomMultipartUploadTarget;
		originalUpload?: {
			key: string;
			upload: LoomMultipartUploadTarget | { type: "put"; url: string };
		};
		existingOutput?: { url: string; objectIdentity: string; fileSize: number };
		maxImportBytes: number;
		outputPresignedUrl: string;
		thumbnailPresignedUrl: string;
		previewGifPresignedUrl?: string;
		webhookUrl: string;
		webhookSecret?: string;
		inputExtension?: string;
		priority: "bulk";
		importPriority?: "customer" | "bulk";
	},
	recordDispatch: (
		state: "accepted" | "rejected" | "uncertain",
		jobId?: string,
	) => Promise<void>,
	importOnly = false,
): Promise<string> {
	for (let attempt = 0; attempt < MEDIA_SERVER_START_MAX_ATTEMPTS; attempt++) {
		const headers: Record<string, string> = {
			"Content-Type": "application/json",
		};
		if (body.webhookSecret) {
			headers["x-media-server-secret"] = body.webhookSecret;
		}

		const endpoint =
			importOnly || body.sourcePresignedUrl || body.sourceUpload
				? "import"
				: "process";
		await recordDispatch("uncertain");
		const response = await fetch(`${mediaServerUrl}/video/${endpoint}`, {
			method: "POST",
			headers,
			body: JSON.stringify(body),
		});

		if (response.ok) {
			const accepted: unknown = await response.json();
			if (
				typeof accepted !== "object" ||
				accepted === null ||
				!("jobId" in accepted) ||
				typeof accepted.jobId !== "string" ||
				!accepted.jobId
			) {
				throw new Error("Loom worker acceptance requires job reconciliation");
			}
			const jobId = accepted.jobId;
			await recordDispatch("accepted", jobId).catch((error) => {
				console.error("Could not record accepted Loom media dispatch", error);
			});
			return jobId;
		}
		const errorData = (await response.json().catch(() => ({}))) as {
			error?: string;
			code?: string;
			details?: string;
		};
		const errorMessage =
			errorData.error ||
			errorData.details ||
			"Video processing failed to start";
		const shouldRetry =
			response.status === 503 && errorData.code === "SERVER_BUSY";
		if ((response.status >= 400 && response.status < 500) || shouldRetry)
			await recordDispatch("rejected");

		if (shouldRetry && attempt < MEDIA_SERVER_START_MAX_ATTEMPTS - 1) {
			await waitForRetry(MEDIA_SERVER_START_RETRY_BASE_MS * 2 ** attempt);
			continue;
		}

		if (shouldRetry) {
			throw createMediaServerCapacityError({
				response,
				message: errorMessage,
				videoId: body.videoId,
				priority: "bulk",
			});
		}

		if (response.status >= 400 && response.status < 500)
			throw new LoomMediaRequestRejectedError(errorMessage);
		throw new Error(errorMessage);
	}

	throw new Error("Video processing failed to start");
}

async function processVideoOnMediaServer(
	payload: ImportLoomPayload,
	loomSourceUrl: string | undefined,
	attemptId: string,
	runId: string,
	savedInputKey?: string,
): Promise<{ jobId: string; worker: LoomWorker }> {
	"use step";

	const { videoId, userId } = payload;
	const rawFileKey = savedInputKey ?? payload.rawFileKey;

	const worker: LoomWorker =
		loomSourceUrl && serverEnv().LOOM_IMPORTER_URL ? "importer" : "media";
	const mediaServerUrl = getLoomWorkerUrl(worker);
	if (!mediaServerUrl) {
		throw new FatalError("MEDIA_SERVER_URL is not configured");
	}
	const artifactKeys = getLoomImportArtifactKeys(userId, videoId, attemptId);
	const originalKey =
		worker === "importer" && loomSourceUrl && !isMp4Url(loomSourceUrl)
			? artifactKeys.originalKey
			: undefined;

	const webhookBaseUrl =
		serverEnv().MEDIA_SERVER_WEBHOOK_URL || serverEnv().WEB_URL;

	const {
		rawVideoUrl,
		originalUpload,
		sourcePresignedUrl,
		outputPresignedUrl,
		thumbnailPresignedUrl,
		previewGifPresignedUrl,
		sourceUpload,
		outputUpload,
		existingOutput,
		abortUploads,
	} = await Effect.gen(function* () {
		const [video] = yield* Effect.promise(() =>
			db()
				.select()
				.from(videos)
				.where(eq(videos.id, Video.VideoId.make(videoId))),
		);
		if (!video) {
			return yield* Effect.fail(new FatalError("Video does not exist"));
		}
		if (video.ownerId !== userId || !ownsLoomImportSource(video, runId)) {
			return yield* Effect.fail(new FatalError("Loom import owner changed"));
		}
		const videoDomain = Video.Video.decodeSync({
			...video,
			bucketId: video.bucket,
			storageIntegrationId: video.storageIntegrationId,
			createdAt: video.createdAt.toISOString(),
			updatedAt: video.updatedAt.toISOString(),
			metadata: video.metadata,
		});
		const [bucket] = yield* Storage.getAccessForVideo(videoDomain);
		const { outputKey, thumbnailKey, previewKey: previewGifKey } = artifactKeys;

		const rawVideoUrl = loomSourceUrl
			? loomSourceUrl
			: yield* bucket.getInternalSignedObjectUrl(rawFileKey, {
					expiresIn: MEDIA_SERVER_PRESIGNED_GET_EXPIRES_SECONDS,
				});
		const sourcePresignedUrl =
			worker === "media" && loomSourceUrl && !isStreamingUrl(loomSourceUrl)
				? yield* bucket.getInternalPresignedPutUrl(
						rawFileKey,
						{ ContentType: "video/mp4" },
						{ expiresIn: MEDIA_SERVER_PRESIGNED_PUT_EXPIRES_SECONDS },
					)
				: undefined;

		const outputPresignedUrl = yield* bucket.getInternalPresignedPutUrl(
			outputKey,
			{ ContentType: "video/mp4" },
			{ expiresIn: MEDIA_SERVER_PRESIGNED_PUT_EXPIRES_SECONDS },
		);

		const thumbnailPresignedUrl = yield* bucket.getInternalPresignedPutUrl(
			thumbnailKey,
			{
				ContentType: "image/jpeg",
			},
			{ expiresIn: MEDIA_SERVER_PRESIGNED_PUT_EXPIRES_SECONDS },
		);

		const previewGifPresignedUrl = yield* bucket.getInternalPresignedPutUrl(
			previewGifKey,
			{
				ContentType: "image/gif",
				CacheControl: "public, max-age=31536000, immutable",
			},
			{ expiresIn: MEDIA_SERVER_PRESIGNED_PUT_EXPIRES_SECONDS },
		);
		const originalPutUrl =
			originalKey && bucket.provider !== "s3"
				? yield* bucket.getInternalPresignedPutUrl(originalKey, {
						ContentType: "video/webm",
					})
				: undefined;
		const multipart = yield* Effect.promise(() =>
			prepareLoomMultipartUploads({
				video,
				bucket,
				attemptId,
				sourceKey:
					worker === "importer"
						? originalKey
						: loomSourceUrl && !isStreamingUrl(loomSourceUrl)
							? rawFileKey
							: undefined,
				webhookBaseUrl,
				webhookSecret: serverEnv().MEDIA_SERVER_WEBHOOK_SECRET || undefined,
			}),
		);

		const originalUpload = originalKey
			? multipart.sourceUpload
				? { key: originalKey, upload: multipart.sourceUpload }
				: originalPutUrl
					? {
							key: originalKey,
							upload: { type: "put" as const, url: originalPutUrl },
						}
					: undefined
			: undefined;

		return {
			rawVideoUrl: multipart.existingOutput?.url ?? rawVideoUrl,
			originalUpload,
			sourcePresignedUrl:
				multipart.sourceUpload || multipart.existingOutput
					? undefined
					: sourcePresignedUrl,
			outputPresignedUrl,
			thumbnailPresignedUrl,
			previewGifPresignedUrl,
			...multipart,
			abortUploads: async () => {
				await Promise.all(
					[multipart.sourceUpload, multipart.outputUpload]
						.filter(
							(upload): upload is LoomMultipartUploadTarget =>
								upload !== undefined,
						)
						.map((upload) =>
							bucket.multipart.abort(upload.key, upload.uploadId).pipe(
								Effect.catchAll(() => Effect.void),
								runWorkflowPromise,
							),
						),
				);
			},
		};
	}).pipe(runWorkflowPromise);

	const webhookUrl = `${webhookBaseUrl}/api/webhooks/media-server/progress?retryable=true&signal=${encodeURIComponent(getLoomImportSignalToken(videoId, attemptId))}${worker === "importer" ? "&transcription=on-view&preview=on-view" : ""}`;
	const webhookSecret = serverEnv().MEDIA_SERVER_WEBHOOK_SECRET;

	const database = db();
	await atomic(database, async (snapshot) => {
		const video = await readLoomImportVideo(snapshot, payload);
		const receipt = video.metadata?.loomImportUpload;
		const currentAttempt =
			video.metadata?.loomImportRun?.mediaDispatch?.attemptId;
		const [upload] = await snapshot.read((reader) =>
			reader
				.select()
				.from(videoUploads)
				.where(eq(videoUploads.videoId, video.id))
				.limit(1),
		);
		if (
			!ownsLoomImportSource(video, runId) ||
			(savedInputKey !== undefined &&
				savedInputKey !== video.metadata?.loomImportRun?.inputKey) ||
			(receipt && receipt.attemptId !== attemptId) ||
			!upload ||
			(upload.rawFileKey &&
				upload.rawFileKey !== payload.rawFileKey &&
				upload.rawFileKey !== video.metadata?.loomImportRun?.inputKey) ||
			(currentAttempt &&
				(!currentAttempt.startsWith(`${runId}:`) ||
					Number(currentAttempt.slice(runId.length + 1)) >
						Number(attemptId.slice(runId.length + 1))))
		)
			throw new FatalError("Loom import was superseded before media dispatch");
		const inputKey = originalKey ?? rawFileKey;
		return {
			statements: [
				database
					.update(videos)
					.set({
						metadata: {
							...video.metadata,
							loomImportRun: {
								...video.metadata?.loomImportRun,
								runId,
								dispatch: video.metadata?.loomImportRun?.dispatch ?? "accepted",
								inputKey,
							},
						},
					})
					.where(eq(videos.id, video.id)),
				database
					.update(videoUploads)
					.set({
						phase: "processing",
						processingProgress: 0,
						processingMessage: "Starting video processing...",
						processingError: null,
						rawFileKey: inputKey,
						updatedAt: new Date(),
					})
					.where(eq(videoUploads.videoId, video.id)),
			],
			result: undefined,
		};
	});

	try {
		const jobId = await startMediaServerProcessJob(
			mediaServerUrl,
			{
				videoId,
				userId,
				videoUrl: rawVideoUrl,
				sourcePresignedUrl,
				sourceUpload: worker === "importer" ? undefined : sourceUpload,
				originalUpload,
				outputUpload,
				existingOutput,
				maxImportBytes: LOOM_IMPORT_MAX_BYTES,
				outputPresignedUrl,
				thumbnailPresignedUrl,
				previewGifPresignedUrl:
					worker === "importer" ? undefined : previewGifPresignedUrl,
				webhookUrl,
				webhookSecret: webhookSecret || undefined,
				inputExtension: getInputExtension(rawVideoUrl),
				priority: "bulk",
				importPriority:
					worker === "importer"
						? (payload.importPriority ?? "customer")
						: undefined,
			},
			(state, jobId) =>
				recordLoomMediaDispatch({
					videoId,
					userId,
					runId,
					attemptId,
					state,
					jobId,
					worker,
				}),
			worker === "importer",
		);
		return { jobId, worker };
	} catch (error) {
		if (error instanceof LoomMediaRequestRejectedError) await abortUploads();
		throw error;
	}
}

processVideoOnMediaServer.maxRetries = 0;

async function saveMetadataAndComplete(
	payload: ImportLoomPayload,
	runId: string,
	metadata: { duration: number; width: number; height: number; fps: number },
	originalKey?: string,
): Promise<void> {
	"use step";
	const database = db();
	await atomic(database, async (snapshot) => {
		const video = await readLoomImportVideo(snapshot, payload);
		if (!ownsLoomImportSource(video, runId))
			throw new FatalError("Loom import was superseded before publication");
		const [upload] = await snapshot.read((reader) =>
			reader
				.select()
				.from(videoUploads)
				.where(eq(videoUploads.videoId, video.id))
				.limit(1),
		);
		const nextMetadata = { ...video.metadata };
		if (
			process.env.CAP_RUNTIME === "cloudflare" &&
			validLoomInputKey(video, originalKey) &&
			nextMetadata.loomDeferredProcessing?.status !== "started"
		)
			nextMetadata.loomDeferredProcessing = {
				rawFileKey: originalKey,
				status: "complete",
			};
		return {
			statements: [
				database
					.update(videos)
					.set({
						width: metadata.width,
						height: metadata.height,
						fps: normalizeVideoFps(metadata.fps),
						...(getValidDuration(metadata.duration) === undefined
							? {}
							: { duration: metadata.duration }),
						metadata: nextMetadata,
						...loomImportSourcePublication(
							video,
							nextMetadata,
							metadata.duration,
						),
					})
					.where(eq(videos.id, video.id)),
				...(upload &&
				video.metadata?.loomDeferredProcessing?.status !== "started"
					? [
							database
								.delete(videoUploads)
								.where(eq(videoUploads.videoId, video.id)),
						]
					: []),
			],
			result: undefined,
		};
	});
}

async function setProcessingError(
	payload: ImportLoomPayload,
	runId: string,
	errorMessage: string,
): Promise<void> {
	"use step";
	const database = db();
	await atomic(database, async (snapshot) => {
		const [video] = await snapshot.read((reader) =>
			reader
				.select()
				.from(videos)
				.where(eq(videos.id, Video.VideoId.make(payload.videoId)))
				.limit(1),
		);
		if (
			!video ||
			video.ownerId !== payload.userId ||
			!ownsLoomImportSource(video, runId) ||
			video.metadata?.processingRun ||
			video.metadata?.editProcessing
		)
			return { statements: [], result: undefined };
		return {
			statements: [
				database
					.update(videoUploads)
					.set({
						phase: "error",
						processingProgress: 0,
						processingMessage: "Loom import failed",
						processingError: errorMessage,
						updatedAt: new Date(),
					})
					.where(eq(videoUploads.videoId, video.id)),
			],
			result: undefined,
		};
	});
}

async function markLoomImportWaitingForCapacity(
	payload: ImportLoomPayload,
	runId: string,
): Promise<void> {
	"use step";
	const database = db();
	await atomic(database, async (snapshot) => {
		const video = await readLoomImportVideo(snapshot, payload);
		if (!ownsLoomImportSource(video, runId))
			throw new FatalError("Loom import was superseded");
		return {
			statements: [
				database
					.update(videoUploads)
					.set({
						processingMessage: "Queued for Loom import processing...",
						processingError: null,
						updatedAt: new Date(),
					})
					.where(eq(videoUploads.videoId, video.id)),
			],
			result: undefined,
		};
	});
}
