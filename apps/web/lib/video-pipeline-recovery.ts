import { db } from "@cap/database/cloudflare/application";
import {
	importedVideos,
	users,
	videos,
	videoUploads,
} from "@cap/database/cloudflare/schema";
import type { VideoMetadata } from "@cap/database/types";
import { buildEnv } from "@cap/env";
import type { User, Video } from "@cap/web-domain";
import {
	and,
	asc,
	eq,
	gte,
	inArray,
	isNotNull,
	isNull,
	lte,
	or,
	sql,
} from "drizzle-orm";
import {
	AI_ENTITLED_SUBSCRIPTION_STATUSES,
	isAiGenerationEnabledForUser,
} from "@/lib/ai-generation-entitlement";
import { startAiGeneration } from "@/lib/generate-ai";
import {
	getLoomImportRunState,
	LOOM_IMPORT_CONFIRMATION_MESSAGE,
	LoomImportStartError,
	startLoomImportWorkflow,
} from "@/lib/loom-import-start";
import { transcribeVideo } from "@/lib/transcribe";
import { startVideoProcessingWorkflow } from "@/lib/video-processing";

export const STALLED_PIPELINE_MIN_AGE_MS = 60 * 60 * 1000;
export const STALLED_PIPELINE_MAX_AGE_MS = 48 * 60 * 60 * 1000;
export const STALLED_MEDIA_RECOVERY_BATCH_SIZE = 50;
export const STALLED_TRANSCRIPTION_RECOVERY_BATCH_SIZE = 50;
export const STALLED_AI_RECOVERY_BATCH_SIZE = 25;

const STALLED_MEDIA_PROCESSING_MESSAGES = [
	"Starting video processing...",
	"Downloading video...",
	"Retrying video processing...",
	"Queued for video processing...",
	"Queued for Loom import processing...",
	"Processing recovery will retry automatically",
	LOOM_IMPORT_CONFIRMATION_MESSAGE,
] as const;

type PipelineRecoveryStatus =
	| "started"
	| "already-claimed"
	| "reconciliation-required"
	| "retry-scheduled"
	| "failed";

type PipelineRecoveryResult = {
	videoId: Video.VideoId;
	status: PipelineRecoveryStatus;
};

type PipelineRecoveryGroup = {
	checked: number;
	statuses: Partial<Record<PipelineRecoveryStatus, number>>;
	results: PipelineRecoveryResult[];
};

export type StalledVideoPipelineRecoverySummary = {
	media: PipelineRecoveryGroup;
	transcription: PipelineRecoveryGroup;
	ai: PipelineRecoveryGroup;
};

const getAffectedRows = (result: { meta: { changes: number } }) =>
	result.meta.changes;

const summarize = (
	results: PipelineRecoveryResult[],
): PipelineRecoveryGroup => {
	const statuses: PipelineRecoveryGroup["statuses"] = {};
	for (const result of results) {
		statuses[result.status] = (statuses[result.status] ?? 0) + 1;
	}

	return { checked: results.length, statuses, results };
};

async function recoverConcurrently<T extends { videoId: Video.VideoId }>(
	candidates: T[],
	concurrency: number,
	recover: (candidate: T) => Promise<PipelineRecoveryStatus>,
): Promise<PipelineRecoveryResult[]> {
	const results: PipelineRecoveryResult[] = new Array(candidates.length);
	let nextIndex = 0;

	const workers = Array.from(
		{ length: Math.min(Math.max(1, concurrency), candidates.length) },
		async () => {
			while (nextIndex < candidates.length) {
				const index = nextIndex++;
				const candidate = candidates[index];
				if (!candidate) continue;

				let status: PipelineRecoveryStatus;
				try {
					status = await recover(candidate);
				} catch (error) {
					status = "failed";
					console.error(
						`[video-pipeline-recovery] Failed to recover ${candidate.videoId}`,
						error,
					);
				}

				results[index] = { videoId: candidate.videoId, status };
			}
		},
	);

	await Promise.all(workers);
	return results;
}

type MediaCandidate = {
	videoId: Video.VideoId;
	userId: User.UserId;
	bucketId: string | null;
	rawFileKey: string;
	loomVideoId: string | null;
	metadata: VideoMetadata | null;
	processingMessage: string;
	updatedAt: Date;
};

async function recoverMediaCandidate(
	candidate: MediaCandidate,
): Promise<PipelineRecoveryStatus> {
	if (!candidate.loomVideoId) {
		try {
			const status = await startVideoProcessingWorkflow({
				videoId: candidate.videoId,
				userId: candidate.userId,
				rawFileKey: candidate.rawFileKey,
				bucketId: candidate.bucketId,
				forceRestart: true,
				expectedUpdatedAt: candidate.updatedAt,
				expectedProcessingToken:
					candidate.metadata?.processingRun?.token ?? null,
				processingMessage: "Restarting video processing",
				startFailureMessage: "Processing recovery will retry automatically",
			});
			return status === "started" ? "started" : "already-claimed";
		} catch {
			return "retry-scheduled";
		}
	}

	const receipt = candidate.metadata?.loomImportRun;
	const receiptCondition = candidate.loomVideoId
		? receipt
			? sql`EXISTS (SELECT 1 FROM ${videos} WHERE ${videos.id} = ${candidate.videoId} AND json_extract(${videos.metadata}, '$.loomImportRun.runId') = ${receipt.runId})`
			: sql`EXISTS (SELECT 1 FROM ${videos} WHERE ${videos.id} = ${candidate.videoId} AND json_extract(${videos.metadata}, '$.loomImportRun') IS NULL)`
		: undefined;
	if (candidate.loomVideoId) {
		const state = await getLoomImportRunState(receipt);
		if (state === "active") return "already-claimed";
		if (!receipt || state !== "inactive") {
			const result = await db()
				.update(videoUploads)
				.set({
					processingMessage: LOOM_IMPORT_CONFIRMATION_MESSAGE,
					updatedAt: new Date(),
				})
				.where(
					and(
						eq(videoUploads.videoId, candidate.videoId),
						eq(videoUploads.phase, "processing"),
						eq(videoUploads.updatedAt, candidate.updatedAt),
						receiptCondition,
					),
				);
			return getAffectedRows(result) === 1
				? "reconciliation-required"
				: "already-claimed";
		}
	}
	const claimedAt = new Date(Math.floor(Date.now() / 1000) * 1000);
	const claimResult = await db()
		.update(videoUploads)
		.set({
			processingProgress: 0,
			processingMessage: "Restarting video processing",
			processingError: null,
			updatedAt: claimedAt,
		})
		.where(
			and(
				eq(videoUploads.videoId, candidate.videoId),
				eq(videoUploads.phase, "processing"),
				eq(videoUploads.processingProgress, 0),
				eq(videoUploads.processingMessage, candidate.processingMessage),
				eq(videoUploads.rawFileKey, candidate.rawFileKey),
				eq(videoUploads.updatedAt, candidate.updatedAt),
				receiptCondition,
			),
		);

	if (getAffectedRows(claimResult) === 0) return "already-claimed";

	try {
		if (candidate.loomVideoId) {
			await startLoomImportWorkflow({
				videoId: candidate.videoId,
				userId: candidate.userId,
				rawFileKey: candidate.rawFileKey,
				bucketId: candidate.bucketId,
				loomVideoId: candidate.loomVideoId,
				reuseExistingRawUpload: true,
				importPriority: receipt?.importPriority,
			});
		}

		return "started";
	} catch (error) {
		const needsReconciliation =
			Boolean(candidate.loomVideoId) &&
			(!(error instanceof LoomImportStartError) || !error.canRetry);
		await db()
			.update(videoUploads)
			.set({
				processingMessage: needsReconciliation
					? LOOM_IMPORT_CONFIRMATION_MESSAGE
					: "Processing recovery will retry automatically",
				updatedAt: new Date(),
			})
			.where(
				and(
					eq(videoUploads.videoId, candidate.videoId),
					eq(videoUploads.phase, "processing"),
					eq(videoUploads.updatedAt, claimedAt),
					eq(videoUploads.processingMessage, "Restarting video processing"),
				),
			);
		return needsReconciliation ? "reconciliation-required" : "retry-scheduled";
	}
}

type TranscriptionCandidate = {
	videoId: Video.VideoId;
	userId: string;
	transcriptionStatus: "PROCESSING" | null;
	updatedAt: Date;
	stripeSubscriptionStatus: string | null;
	thirdPartyStripeSubscriptionId: string | null;
};

async function recoverTranscriptionCandidate(
	candidate: TranscriptionCandidate,
): Promise<PipelineRecoveryStatus> {
	if (candidate.transcriptionStatus === "PROCESSING") {
		const claimResult = await db()
			.update(videos)
			.set({ transcriptionStatus: null })
			.where(
				and(
					eq(videos.id, candidate.videoId),
					eq(videos.transcriptionStatus, "PROCESSING"),
					eq(videos.updatedAt, candidate.updatedAt),
				),
			);

		if (getAffectedRows(claimResult) === 0) return "already-claimed";
	}

	const result = await transcribeVideo(
		candidate.videoId,
		candidate.userId,
		isAiGenerationEnabledForUser(candidate),
	);

	if (!result.success) return "retry-scheduled";
	return result.message === "Transcription workflow started"
		? "started"
		: "already-claimed";
}

type AiCandidate = {
	videoId: Video.VideoId;
	userId: string;
	metadata: VideoMetadata | null;
	updatedAt: Date;
	stripeSubscriptionStatus: string | null;
	thirdPartyStripeSubscriptionId: string | null;
};

async function recoverAiCandidate(
	candidate: AiCandidate,
): Promise<PipelineRecoveryStatus> {
	const metadata = candidate.metadata ?? {};
	const status = metadata.aiGenerationStatus;
	if (status === "QUEUED" || status === "PROCESSING") {
		const claimResult = await db()
			.update(videos)
			.set({
				metadata: {
					...metadata,
					aiGenerationStatus: "ERROR",
				},
			})
			.where(
				and(
					eq(videos.id, candidate.videoId),
					eq(videos.updatedAt, candidate.updatedAt),
					sql`json_extract(${videos.metadata}, '$.aiGenerationStatus') = ${status}`,
				),
			);

		if (getAffectedRows(claimResult) === 0) return "already-claimed";
	}

	const result = await startAiGeneration(candidate.videoId, candidate.userId);
	if (!result.success) return "failed";
	return result.message === "AI generation workflow started"
		? "started"
		: "already-claimed";
}

export async function recoverStalledVideoPipeline({
	now = new Date(),
	mediaLimit = STALLED_MEDIA_RECOVERY_BATCH_SIZE,
	transcriptionLimit = STALLED_TRANSCRIPTION_RECOVERY_BATCH_SIZE,
	aiLimit = STALLED_AI_RECOVERY_BATCH_SIZE,
	concurrency = 5,
}: {
	now?: Date;
	mediaLimit?: number;
	transcriptionLimit?: number;
	aiLimit?: number;
	concurrency?: number;
} = {}): Promise<StalledVideoPipelineRecoverySummary> {
	const staleBefore = new Date(now.getTime() - STALLED_PIPELINE_MIN_AGE_MS);
	const recentBefore = new Date(now.getTime() - STALLED_PIPELINE_MAX_AGE_MS);

	const mediaCandidates = await db()
		.select({
			videoId: videos.id,
			userId: videos.ownerId,
			bucketId: videos.bucket,
			rawFileKey: videoUploads.rawFileKey,
			loomVideoId: importedVideos.sourceId,
			metadata: videos.metadata,
			processingMessage: videoUploads.processingMessage,
			updatedAt: videoUploads.updatedAt,
		})
		.from(videos)
		.innerJoin(videoUploads, eq(videos.id, videoUploads.videoId))
		.leftJoin(
			importedVideos,
			and(
				eq(importedVideos.orgId, videos.orgId),
				eq(importedVideos.source, "loom"),
				eq(importedVideos.id, videos.id),
			),
		)
		.where(
			and(
				eq(videoUploads.phase, "processing"),
				eq(videoUploads.processingProgress, 0),
				inArray(
					videoUploads.processingMessage,
					STALLED_MEDIA_PROCESSING_MESSAGES,
				),
				isNotNull(videoUploads.rawFileKey),
				lte(videoUploads.updatedAt, staleBefore),
				gte(videoUploads.startedAt, recentBefore),
				sql`json_extract(${videos.source}, '$.type') = 'webMP4'`,
			),
		)
		.orderBy(asc(videoUploads.updatedAt))
		.limit(mediaLimit);

	const transcriptionCandidates = await db()
		.select({
			videoId: videos.id,
			userId: videos.ownerId,
			transcriptionStatus: videos.transcriptionStatus,
			updatedAt: videos.updatedAt,
			stripeSubscriptionStatus: users.stripeSubscriptionStatus,
			thirdPartyStripeSubscriptionId: users.thirdPartyStripeSubscriptionId,
		})
		.from(videos)
		.innerJoin(users, eq(videos.ownerId, users.id))
		.leftJoin(videoUploads, eq(videos.id, videoUploads.videoId))
		.where(
			and(
				isNull(videoUploads.videoId),
				eq(videos.isScreenshot, false),
				gte(videos.createdAt, recentBefore),
				lte(videos.updatedAt, staleBefore),
				or(
					and(
						isNull(videos.transcriptionStatus),
						sql`json_extract(${videos.metadata}, '$.transcribeOnView') IS NULL`,
					),
					eq(videos.transcriptionStatus, "PROCESSING"),
				),
			),
		)
		.orderBy(asc(videos.updatedAt))
		.limit(transcriptionLimit);

	const aiCandidates = (
		await db()
			.select({
				videoId: videos.id,
				userId: videos.ownerId,
				metadata: videos.metadata,
				updatedAt: videos.updatedAt,
				stripeSubscriptionStatus: users.stripeSubscriptionStatus,
				thirdPartyStripeSubscriptionId: users.thirdPartyStripeSubscriptionId,
			})
			.from(videos)
			.innerJoin(users, eq(videos.ownerId, users.id))
			.leftJoin(videoUploads, eq(videos.id, videoUploads.videoId))
			.where(
				and(
					isNull(videoUploads.videoId),
					eq(videos.isScreenshot, false),
					eq(videos.transcriptionStatus, "COMPLETE"),
					gte(videos.createdAt, recentBefore),
					lte(videos.updatedAt, staleBefore),
					or(
						// Transcribe-on-view videos (Loom imports) only start AI from a
						// view; recovery resumes AI a view started but never starts it.
						and(
							isNull(
								sql`json_extract(${videos.metadata}, '$.aiGenerationStatus')`,
							),
							sql`json_extract(${videos.metadata}, '$.transcribeOnView') IS NULL`,
						),
						inArray(
							sql<string>`json_extract(${videos.metadata}, '$.aiGenerationStatus')`,
							["QUEUED", "PROCESSING"],
						),
					),
					sql`(${videos.metadata} IS NULL OR json_extract(${videos.metadata}, '$.summary') IS NULL OR json_extract(${videos.metadata}, '$.chapters') IS NULL)`,
					// Filtering entitlement after LIMIT let older ineligible videos
					// fill every batch, so eligible ones were never reached.
					buildEnv.NEXT_PUBLIC_IS_CAP === "true"
						? or(
								sql`COALESCE(${users.thirdPartyStripeSubscriptionId}, '') <> ''`,
								inArray(
									users.stripeSubscriptionStatus,
									AI_ENTITLED_SUBSCRIPTION_STATUSES,
								),
							)
						: undefined,
				),
			)
			.orderBy(asc(videos.updatedAt))
			.limit(aiLimit)
	).filter(isAiGenerationEnabledForUser) as AiCandidate[];

	const [media, transcription, ai] = await Promise.all([
		recoverConcurrently(
			mediaCandidates as MediaCandidate[],
			concurrency,
			recoverMediaCandidate,
		),
		recoverConcurrently(
			transcriptionCandidates as TranscriptionCandidate[],
			concurrency,
			recoverTranscriptionCandidate,
		),
		recoverConcurrently(aiCandidates, concurrency, recoverAiCandidate),
	]);

	return {
		media: summarize(media),
		transcription: summarize(transcription),
		ai: summarize(ai),
	};
}
