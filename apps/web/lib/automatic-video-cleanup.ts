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

function editPayload(request: AutomaticCleanupRequest, cleanup: Cleanup) {
	return {
		videoId: request.videoId,
		userId: request.ownerId,
		sourceKey: cleanup.sourceKey,
		previousSpec: createIdentityEditSpec(cleanup.editSpec.sourceDuration),
		editSpec: cleanup.editSpec,
		keepRanges: cleanup.editSpec.keepRanges,
		operation: cleanup.operation,
		aiGenerationEnabled: request.aiGenerationEnabled,
	};
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
		await ensureOriginalSourceCopy(
			video,
			existing.sourceKey,
			!getVideoEditingBase(video),
		);
		return editPayload(request, existing);
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
	await ensureOriginalSourceCopy(
		video,
		cleanup.sourceKey,
		!getVideoEditingBase(video),
	);
	return editPayload(request, cleanup);
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
