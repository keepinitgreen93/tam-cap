import "server-only";

import { randomUUID } from "node:crypto";
import { db } from "@cap/database/cloudflare/application";
import { atomic } from "@cap/database/cloudflare/atomic";
import {
	videoEdits,
	videos,
	videoUploads,
} from "@cap/database/cloudflare/schema";
import { readTranscriptArtifacts } from "@cap/database/cloudflare/transcript-publication";
import type { VideoMetadata } from "@cap/database/types";
import { writableVideo } from "@cap/web-backend/src/Videos/persistence";
import { Video } from "@cap/web-domain";
import { and, eq } from "drizzle-orm";
import { Option } from "effect";
import { RetryableError } from "workflow";
import { start } from "workflow/api";
import { analyzeVideoSilence } from "@/lib/analyze-video-silence";
import { planAutomaticCleanup } from "@/lib/automatic-video-cleanup-plan";
import { parseEditTranscript } from "@/lib/edit-transcript";
import {
	loadSilenceSource,
	readSilenceResult,
} from "@/lib/silence-analysis-storage";
import {
	clearPendingEdit,
	getEditProcessingState,
} from "@/lib/video-edit-operation";
import { getEditSourceKey } from "@/lib/video-edit-processing";
import {
	ensureOriginalSourceCopy,
	getCompletedProcessingReceipt,
	getPublishedResultKey,
	markEditProcessing,
} from "@/lib/video-edit-start";
import { getVideoEditingBase } from "@/lib/video-editing-base";
import {
	areEditSpecsEquivalent,
	createIdentityEditSpec,
} from "@/lib/video-edits";
import { runWorkflowPromise } from "@/lib/workflow-runtime";
import { automaticVideoCleanupWorkflow } from "@/workflows/automatic-video-cleanup";

export type AutomaticCleanupRequest = {
	videoId: string;
	ownerId: string;
	requestId: string;
	aiGenerationEnabled: boolean;
};
type Cleanup = NonNullable<VideoMetadata["automaticCleanup"]>;

export function automaticVideoCleanupEnabled() {
	return (
		process.env.CAP_RUNTIME === "cloudflare" &&
		process.env.DATABASE_PROVIDER === "d1"
	);
}

export async function queueAutomaticVideoCleanup(
	videoId: string,
	ownerId: string,
	aiGenerationEnabled = true,
) {
	if (!automaticVideoCleanupEnabled()) return { queued: false };
	const [video] = await db()
		.select()
		.from(videos)
		.where(and(writableVideo, eq(videos.id, Video.VideoId.make(videoId))));
	if (
		!video ||
		video.ownerId !== ownerId ||
		video.isScreenshot ||
		video.transcriptionStatus !== "COMPLETE" ||
		!video.metadata?.transcriptPublication?.edit ||
		video.metadata.automaticCleanup ||
		video.metadata.completedVideoEdit ||
		video.metadata.editProcessing
	)
		return { queued: false };
	await start(automaticVideoCleanupWorkflow, [
		{ videoId, ownerId, requestId: randomUUID(), aiGenerationEnabled },
	]);
	return { queued: true };
}

/**
 * A recording without an editing base renders from the published file while
 * its preserved original is copied alongside; the edit workflow confirms that
 * copy before it publishes the cut.
 */
function editPayload(
	request: AutomaticCleanupRequest,
	cleanup: Cleanup,
	video: typeof videos.$inferSelect,
) {
	return {
		videoId: request.videoId,
		userId: request.ownerId,
		sourceKey: cleanup.sourceKey,
		previousSpec: createIdentityEditSpec(cleanup.editSpec.sourceDuration),
		editSpec: cleanup.editSpec,
		keepRanges: cleanup.editSpec.keepRanges,
		operation: cleanup.operation,
		aiGenerationEnabled: request.aiGenerationEnabled,
		...(getVideoEditingBase(video)
			? {}
			: {
					renderSourceKey: getPublishedResultKey(video),
					confirmSourceCopy: true,
				}),
	};
}

const PREWARM_MINIMUM_MS = 60_000;
const PREWARM_MAXIMUM_MS = 15 * 60_000;
const PREWARM_BUSY_ATTEMPTS = 8;
const PREWARM_BUSY_WAIT_MS = 3_000;
const silencePrewarms = new Map<string, Promise<boolean>>();
const sourceCopies = new Map<string, Promise<boolean>>();

/**
 * Starts measuring quiet ranges without waiting for the result, so the
 * measurement overlaps the transcription instead of following it. The work is
 * a cache fill owned by this process: if the process stops, cleanup measures
 * the audio itself exactly as it did before.
 */
export function startAutomaticCleanupSilencePrewarm(
	videoId: string,
	ownerId: string,
) {
	if (!automaticVideoCleanupEnabled() || silencePrewarms.has(videoId)) return;
	const run = prewarmAutomaticCleanupSilence(videoId, ownerId).finally(() => {
		if (silencePrewarms.get(videoId) === run) silencePrewarms.delete(videoId);
	});
	silencePrewarms.set(videoId, run);
}

async function prewarmAutomaticCleanupSilence(
	videoId: string,
	ownerId: string,
) {
	try {
		const id = Video.VideoId.make(videoId);
		const [video] = await db()
			.select()
			.from(videos)
			.where(and(writableVideo, eq(videos.id, id)));
		if (
			!video ||
			video.ownerId !== ownerId ||
			video.isScreenshot ||
			video.metadata?.automaticCleanup ||
			video.metadata?.completedVideoEdit ||
			video.metadata?.editProcessing
		)
			return false;
		const source = await loadSilenceSource(id, ownerId);
		if (await readSilenceResult(source)) return true;
		const timeoutMs = Math.min(
			PREWARM_MAXIMUM_MS,
			PREWARM_MINIMUM_MS + Math.round(source.durationMs * 0.2),
		);
		let analysis: Awaited<ReturnType<typeof analyzeVideoSilence>> | undefined;
		// The media server finishes publishing the recording's previews just
		// after transcription starts, so a busy answer is asked again shortly.
		for (let attempt = 0; !analysis; attempt++) {
			try {
				analysis = await analyzeVideoSilence(source, timeoutMs);
			} catch (error) {
				if (
					!(error instanceof RetryableError) ||
					attempt + 1 >= PREWARM_BUSY_ATTEMPTS
				)
					throw error;
				await new Promise((resolve) =>
					setTimeout(resolve, PREWARM_BUSY_WAIT_MS),
				);
			}
		}
		const current = await loadSilenceSource(id, ownerId);
		if (source.revision !== current.revision) return false;
		await source.bucket
			.putObject(source.resultKey, JSON.stringify(analysis), {
				contentType: "application/json",
			})
			.pipe(runWorkflowPromise);
		return true;
	} catch {
		return false;
	}
}

/**
 * Writes the preserved original while the render is already running. The
 * render reads the published recording, which holds the same bytes, and the
 * edit workflow confirms this copy exists before it publishes the cut.
 */
function startOriginalSourceCopy(
	video: typeof videos.$inferSelect,
	sourceKey: string,
) {
	if (sourceCopies.has(sourceKey)) return;
	const run = ensureOriginalSourceCopy(video, sourceKey, true)
		.then(
			() => true,
			() => false,
		)
		.finally(() => {
			if (sourceCopies.get(sourceKey) === run) sourceCopies.delete(sourceKey);
		});
	sourceCopies.set(sourceKey, run);
}

export async function prepareAutomaticVideoCleanup(
	request: AutomaticCleanupRequest,
) {
	if (!automaticVideoCleanupEnabled()) return null;
	const videoId = Video.VideoId.make(request.videoId);
	const [video] = await db()
		.select()
		.from(videos)
		.where(and(writableVideo, eq(videos.id, videoId)));
	if (!video || video.ownerId !== request.ownerId || video.isScreenshot)
		return null;
	const existing = video.metadata?.automaticCleanup;
	if (existing) {
		if (
			existing.requestId !== request.requestId ||
			existing.status !== "processing" ||
			getEditProcessingState(video.metadata)?.token !== existing.operation.token
		)
			return null;
		if (getVideoEditingBase(video))
			await ensureOriginalSourceCopy(video, existing.sourceKey);
		else if (!getEditProcessingState(video.metadata)?.resultCommitted)
			startOriginalSourceCopy(video, existing.sourceKey);
		return editPayload(request, existing, video);
	}
	if (
		video.metadata?.editProcessing ||
		video.metadata?.completedVideoEdit ||
		video.transcriptionStatus !== "COMPLETE" ||
		!video.metadata?.transcriptPublication?.edit
	)
		return null;
	const [edit] = await db()
		.select()
		.from(videoEdits)
		.where(eq(videoEdits.videoId, videoId));
	if (edit) return null;
	// A measurement started during transcription is finished rather than
	// repeated; the media server only runs one at a time.
	await silencePrewarms.get(request.videoId);
	const source = await loadSilenceSource(videoId, request.ownerId);
	const artifacts = await readTranscriptArtifacts(video, {
		getText: async (key) =>
			Option.getOrNull(
				await source.bucket.getObject(key).pipe(runWorkflowPromise),
			),
	});
	const transcript = artifacts.editTranscript
		? parseEditTranscript(artifacts.editTranscript)
		: null;
	if (!transcript || Math.abs(transcript.durationMs - source.durationMs) > 100)
		throw new Error(
			"Automatic cleanup is waiting for the original word transcript",
		);
	const cached = await readSilenceResult(source);
	const analysis = cached ?? (await analyzeVideoSilence(source));
	const currentSource = await loadSilenceSource(videoId, request.ownerId);
	if (source.revision !== currentSource.revision) return null;
	if (!cached)
		await source.bucket
			.putObject(source.resultKey, JSON.stringify(analysis), {
				contentType: "application/json",
			})
			.pipe(runWorkflowPromise);
	const plan = planAutomaticCleanup(transcript, analysis.ranges);
	const previousSpec = createIdentityEditSpec(transcript.durationMs / 1000);
	const cleanup: Cleanup = {
		version: 1,
		requestId: request.requestId,
		transcriptId: video.metadata.transcriptPublication.id,
		status: areEditSpecsEquivalent(previousSpec, plan.editSpec)
			? "skipped"
			: "processing",
		operation: {
			token: request.requestId,
			startedAt: new Date(Math.floor(Date.now() / 1000) * 1000).toISOString(),
		},
		sourceKey: getVideoEditingBase(video)
			? getEditSourceKey(video.ownerId, video.id, video.metadata)
			: `${video.ownerId}/${video.id}/.recording/automatic-cleanup/${request.requestId}/original.mp4`,
		...plan,
	};
	if (cleanup.status === "skipped") {
		await atomic(db(), async (snapshot) => {
			const [current] = await snapshot.read((reader) =>
				reader
					.select()
					.from(videos)
					.where(and(writableVideo, eq(videos.id, videoId))),
			);
			if (
				!current ||
				current.ownerId !== request.ownerId ||
				current.metadata?.automaticCleanup ||
				current.metadata?.editProcessing ||
				current.metadata?.completedVideoEdit ||
				current.metadata?.transcriptPublication?.id !== cleanup.transcriptId
			)
				return { statements: [], result: undefined };
			return {
				statements: [
					db()
						.update(videos)
						.set({
							metadata: { ...current.metadata, automaticCleanup: cleanup },
						})
						.where(eq(videos.id, videoId)),
				],
				result: undefined,
			};
		});
		return null;
	}
	const [upload] = await db()
		.select()
		.from(videoUploads)
		.where(eq(videoUploads.videoId, videoId));
	await markEditProcessing({
		video,
		sourceKey: cleanup.sourceKey,
		previousSpec,
		completedUpload: getCompletedProcessingReceipt(video, upload),
		automaticCleanup: cleanup,
	});
	if (getVideoEditingBase(video))
		await ensureOriginalSourceCopy(video, cleanup.sourceKey);
	else startOriginalSourceCopy(video, cleanup.sourceKey);
	return editPayload(request, cleanup, video);
}

export async function finishAutomaticVideoCleanup(
	request: AutomaticCleanupRequest,
	status: "complete" | "error",
) {
	if (status === "error") {
		const [video] = await db()
			.select()
			.from(videos)
			.where(eq(videos.id, Video.VideoId.make(request.videoId)));
		const cleanup = video?.metadata?.automaticCleanup;
		if (
			video?.ownerId === request.ownerId &&
			cleanup?.requestId === request.requestId
		)
			await clearPendingEdit(
				request.videoId,
				cleanup.sourceKey,
				cleanup.operation,
			);
	}
	await atomic(db(), async (snapshot) => {
		const videoId = Video.VideoId.make(request.videoId);
		const [video] = await snapshot.read((reader) =>
			reader
				.select()
				.from(videos)
				.where(and(writableVideo, eq(videos.id, videoId))),
		);
		const cleanup = video?.metadata?.automaticCleanup;
		if (
			!video ||
			video.ownerId !== request.ownerId ||
			cleanup?.requestId !== request.requestId ||
			cleanup.status !== "processing"
		)
			return { statements: [], result: undefined };
		return {
			statements: [
				db()
					.update(videos)
					.set({
						metadata: {
							...video.metadata,
							automaticCleanup: { ...cleanup, status },
						},
					})
					.where(eq(videos.id, videoId)),
			],
			result: undefined,
		};
	});
}
