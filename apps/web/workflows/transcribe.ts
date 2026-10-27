import { randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { requireActiveOrganization } from "@cap/database/cloudflare/access";
import { db } from "@cap/database/cloudflare/application";
import { atomic } from "@cap/database/cloudflare/atomic";
import {
	videoEdits,
	videos,
	videoUploads,
} from "@cap/database/cloudflare/schema";
import {
	claimTranscriptionRun,
	releaseTranscriptionRun,
	setTranscriptionRunStatus,
	transcriptionAudioFilename,
	validateTranscriptionRun,
} from "@cap/database/cloudflare/transcription-state";
import type { VideoEditSpec } from "@cap/database/types";
import { serverEnv } from "@cap/env";
import { Storage } from "@cap/web-backend/src/Storage/index";
import {
	type AiGenerationLanguage,
	parseAiGenerationLanguage,
	Video,
} from "@cap/web-domain";
import { eq, sql } from "drizzle-orm";
import { Either, Option, Schema } from "effect";
import { FatalError } from "workflow";
import {
	ENHANCED_AUDIO_CONTENT_TYPE,
	ENHANCED_AUDIO_EXTENSION,
	enhanceAudioFromUrl,
} from "@/lib/audio-enhance";
import { checkHasAudioTrack, extractAudioFromUrl } from "@/lib/audio-extract";
import {
	createEditTranscript,
	editTranscriptWordsToCaptionVtt,
	getEditTranscriptBackfillStatus,
	serializeEditTranscript,
} from "@/lib/edit-transcript";
import { startAiGeneration } from "@/lib/generate-ai";
import {
	checkHasAudioTrackViaMediaServer,
	extractAudioViaMediaServer,
	isMediaServerConfigured,
	probeVideoViaMediaServer,
} from "@/lib/media-client";
import { planSegmentsAudioExtraction } from "@/lib/segments-audio";
import { downloadConcatenatedSegments } from "@/lib/segments-audio-download";
import {
	getTranscriptPublication,
	metadataWithTranscriptPublication,
	prepareTranscriptPublication,
	readOriginalEditTranscript,
	readTranscriptPublicationOutcome,
	readTranscriptVtt,
	TranscriptPublicationConflictError,
	transcriptMediaRevision,
} from "@/lib/transcript-publication";
import { isTranscriptionConfigured } from "@/lib/transcription-config";
import { dispatchTranscriptionRun } from "@/lib/transcription-dispatch";
import { transcribeAudio } from "@/lib/transcription-provider";
import { decodeStorageVideo } from "@/lib/video-storage";
import { runWorkflowPromise } from "@/lib/workflow-runtime";

interface TranscribeWorkflowPayload {
	runId: string;
	videoId: string;
	userId: string;
	aiGenerationEnabled: boolean;
	/**
	 * The recording's segments are fully uploaded but the mux into result.mp4
	 * has not finished; transcribe directly from the segment audio and defer
	 * back to the normal post-mux queue if that isn't possible.
	 */
	earlyFromSegments?: boolean;
}

interface VideoData {
	video: typeof videos.$inferSelect;
	transcriptionDisabled: boolean;
	aiGenerationLanguage: AiGenerationLanguage;
}

interface BackfillEditTranscriptPayload {
	videoId: string;
	userId: string;
	requestId: string;
}

const editTranscriptTempAudioFilename = (requestId: string) => {
	if (
		!/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(
			requestId,
		)
	)
		throw new FatalError("Invalid transcript request identity");
	return `.recording/transcription/${requestId}/edit-audio.mp3`;
};

interface TranscriptionArtifacts {
	vtt: string;
	editTranscript: string;
}

interface ExtractedAudio {
	audioUrl: string;
	durationMs?: number;
}

function durationMilliseconds(seconds: number | null | undefined) {
	return typeof seconds === "number" && Number.isFinite(seconds) && seconds > 0
		? Math.round(seconds * 1000)
		: undefined;
}

export async function transcribeVideoWorkflow(
	payload: TranscribeWorkflowPayload,
) {
	"use workflow";

	const { videoId, userId, aiGenerationEnabled } = payload;

	const validation = await validateVideo(videoId, userId, payload.runId);
	if (validation.state !== "ready") {
		if (
			validation.state === "source-changed" &&
			(await releaseSupersededTranscription(videoId, userId, payload.runId))
		)
			await requeueAfterEarlyDefer(videoId, userId, aiGenerationEnabled);
		return {
			success: true,
			message: "Transcription superseded; current media will be processed",
		};
	}
	const videoData = validation.data;

	if (videoData.transcriptionDisabled) {
		await markSkipped(videoData.video);
		return { success: true, message: "Transcription disabled - skipped" };
	}

	try {
		let audioUrl: string | null;
		let videoDurationMs = durationMilliseconds(videoData.video.duration) ?? 0;

		if (payload.earlyFromSegments) {
			const segments = await extractAudioFromSegmentsStep(
				videoId,
				userId,
				videoData.video,
			);

			if (segments.status === "no-audio") {
				await markNoAudio(videoData.video);
				return {
					success: true,
					message: "Video has no audio track - skipped transcription",
				};
			}

			if (segments.status !== "ok" || !segments.audioUrl) {
				// The early path must never end worse than today's timing: clean up
				// while we still hold the claim, release it, then explicitly re-offer
				// the video to the normal path — the post-mux queue may have already
				// run and been rejected by our claim, so we cannot rely on it firing
				// again.
				await cleanupTempAudio(videoId, userId, videoData.video);
				await deferEarlyTranscription(videoData.video);
				await requeueAfterEarlyDefer(videoId, userId, aiGenerationEnabled);
				return {
					success: true,
					message: `Early transcription deferred: ${
						segments.status === "unavailable" ? segments.reason : "no audio URL"
					}`,
				};
			}

			audioUrl = segments.audioUrl;
			if (videoDurationMs <= 0 && (segments.durationMs ?? 0) > 0) {
				videoDurationMs = segments.durationMs ?? 0;
			}
		} else {
			const audio = await extractAudio(videoId, userId, videoData.video);
			audioUrl = audio?.audioUrl ?? null;
			if (videoDurationMs <= 0) videoDurationMs = audio?.durationMs ?? 0;
		}

		if (!audioUrl) {
			await markNoAudio(videoData.video);
			return {
				success: true,
				message: "Video has no audio track - skipped transcription",
			};
		}

		const transcription = await transcribeWithProvider(
			audioUrl,
			videoData.aiGenerationLanguage,
			videoDurationMs,
		);

		const published = await saveTranscription(
			videoId,
			userId,
			videoData.video,
			transcription,
		);
		if (!published)
			return {
				success: true,
				message: "Transcription disabled before publication",
			};
	} catch (error) {
		if (
			error instanceof Error &&
			error.name === "TranscriptPublicationConflictError"
		) {
			const released = await releaseSupersededTranscription(
				videoData.video.id,
				videoData.video.ownerId,
				payload.runId,
			);
			await cleanupTempAudio(videoId, userId, videoData.video);
			if (released)
				await requeueAfterEarlyDefer(videoId, userId, aiGenerationEnabled);
			return {
				success: true,
				message: "Recording changed; transcription requeued",
			};
		}

		if (
			typeof error === "object" &&
			error !== null &&
			"message" in error &&
			typeof error.message === "string" &&
			error.message.toLowerCase().includes("no spoken audio")
		) {
			await markNoAudio(videoData.video);
			await cleanupTempAudio(videoId, userId, videoData.video);
			return {
				success: true,
				message: "Video has no spoken audio - skipped transcription",
			};
		}

		await markError(videoData.video);
		await cleanupTempAudio(videoId, userId, videoData.video);
		throw error;
	}

	await cleanupTempAudio(videoId, userId, videoData.video);

	if (aiGenerationEnabled) {
		await queueAiGeneration(videoId, userId);
	}

	return { success: true, message: "Transcription completed successfully" };
}

export async function backfillEditTranscriptWorkflow(
	payload: BackfillEditTranscriptPayload,
) {
	"use workflow";

	const { videoId, userId, requestId } = payload;
	let video: typeof videos.$inferSelect | undefined;

	try {
		video = await validateEditTranscriptBackfill(videoId, userId, requestId);
		// Legacy videos only: the transcript must describe the ORIGINAL media, so
		// edited videos are transcribed from their preserved source mp4.
		const videoEdit = await loadVideoEditForBackfill(videoId);
		const audio = await extractAudio(
			videoId,
			userId,
			video,
			editTranscriptTempAudioFilename(requestId),
			videoEdit?.sourceKey,
		);
		if (!audio) {
			await saveEditTranscriptBackfillError(videoId, requestId, video);
			return { success: false };
		}

		const editTranscript = await transcribeEditTranscriptWithProvider(
			audio.audioUrl,
			(durationMilliseconds(
				videoEdit ? videoEdit.editSpec.sourceDuration : video.duration,
			) ??
				audio.durationMs ??
				0) / 1000,
		);
		await saveEditTranscriptBackfill(
			videoId,
			userId,
			requestId,
			video,
			editTranscript,
		);
		await cleanupTempAudio(
			videoId,
			userId,
			video,
			editTranscriptTempAudioFilename(requestId),
		);
		return { success: true };
	} catch (error) {
		console.error(
			`[transcribe] Editable transcript backfill failed for ${videoId}`,
			error,
		);
		const loadedVideo =
			video ?? (await loadVideoForEditTranscriptBackfill(videoId));
		if (loadedVideo?.ownerId === userId) {
			await saveEditTranscriptBackfillError(videoId, requestId, loadedVideo);
			await cleanupTempAudio(
				videoId,
				userId,
				loadedVideo,
				editTranscriptTempAudioFilename(requestId),
			);
		}
		return { success: false };
	}
}

async function releaseSupersededTranscription(
	videoId: string,
	ownerId: string,
	runId: string,
) {
	"use step";
	return releaseTranscriptionRun(db(), {
		videoId: videoId as Video.VideoId,
		ownerId: ownerId as typeof videos.$inferSelect.ownerId,
		runId,
	});
}
async function validateVideo(videoId: string, userId: string, runId: string) {
	"use step";
	if (!isTranscriptionConfigured(serverEnv()))
		throw new FatalError("Missing transcription provider credentials");
	const result = await validateTranscriptionRun(
		db(),
		videoId as Video.VideoId,
		userId as typeof videos.$inferSelect.ownerId,
		runId,
	);
	if (result.state !== "ready") return result;
	return {
		state: "ready" as const,
		data: {
			video: result.video,
			transcriptionDisabled:
				result.video.settings?.disableTranscript ??
				result.organizationSettings?.disableTranscript ??
				false,
			aiGenerationLanguage: parseAiGenerationLanguage(
				result.organizationSettings?.aiGenerationLanguage,
			),
		} satisfies VideoData,
	};
}
async function loadVideoForEditTranscriptBackfill(videoId: string) {
	"use step";

	const [video] = await db()
		.select()
		.from(videos)
		.where(eq(videos.id, videoId as Video.VideoId));
	return video ?? null;
}

async function loadVideoEditForBackfill(
	videoId: string,
): Promise<{ sourceKey: string; editSpec: VideoEditSpec } | null> {
	"use step";

	const [edit] = await db()
		.select({
			sourceKey: videoEdits.sourceKey,
			editSpec: videoEdits.editSpec,
		})
		.from(videoEdits)
		.where(eq(videoEdits.videoId, videoId as Video.VideoId));

	return edit ?? null;
}

async function validateEditTranscriptBackfill(
	videoId: string,
	userId: string,
	requestId: string,
) {
	"use step";

	if (!isTranscriptionConfigured(serverEnv())) {
		throw new FatalError("Missing transcription provider credentials");
	}

	const [video] = await db()
		.select()
		.from(videos)
		.where(eq(videos.id, videoId as Video.VideoId));
	if (!video || video.ownerId !== userId) {
		throw new FatalError("Video does not exist");
	}
	if (
		video.transcriptionStatus !== "COMPLETE" ||
		video.isScreenshot ||
		(video.source.type !== "desktopMP4" && video.source.type !== "webMP4") ||
		!video.duration ||
		video.duration <= 0
	) {
		throw new FatalError("Transcript editing is not available");
	}
	const status = getEditTranscriptBackfillStatus(video.metadata);
	if (status?.status !== "processing" || status.requestId !== requestId) {
		throw new FatalError("Transcript request expired");
	}

	return video;
}

async function markSkipped(video: typeof videos.$inferSelect): Promise<void> {
	"use step";
	await setTranscriptionRunStatus(db(), video, "SKIPPED");
}
async function markNoAudio(video: typeof videos.$inferSelect): Promise<void> {
	"use step";
	await setTranscriptionRunStatus(db(), video, "NO_AUDIO");
}
async function markError(video: typeof videos.$inferSelect): Promise<void> {
	"use step";
	await setTranscriptionRunStatus(db(), video, "ERROR");
}
async function deferEarlyTranscription(
	video: typeof videos.$inferSelect,
): Promise<void> {
	"use step";
	const runId = video.metadata?.transcriptionRun?.id;
	if (runId)
		await releaseTranscriptionRun(db(), {
			videoId: video.id,
			ownerId: video.ownerId,
			runId,
		});
}
/**
 * After an early-path deferral, put the video back on the normal
 * transcription path. Mirrors lib/transcribe.ts semantics without importing
 * it (that would be a module cycle): no-op while the mux still owns the
 * upload row — its completion queues transcription — otherwise claim and
 * start a normal (non-early) workflow right away.
 */
async function requeueAfterEarlyDefer(
	videoId: string,
	userId: string,
	aiGenerationEnabled: boolean,
): Promise<void> {
	"use step";

	const upload = await db()
		.select({ phase: videoUploads.phase })
		.from(videoUploads)
		.where(eq(videoUploads.videoId, videoId as Video.VideoId))
		.limit(1);

	if (
		upload[0]?.phase === "uploading" ||
		upload[0]?.phase === "processing" ||
		upload[0]?.phase === "generating_thumbnail"
	) {
		return;
	}

	const claimed = await claimTranscriptionRun(
		db(),
		videoId as Video.VideoId,
		userId as typeof videos.$inferSelect.ownerId,
	);
	if (!claimed) return;
	await dispatchTranscriptionRun(
		transcribeVideoWorkflow,
		claimed.video,
		aiGenerationEnabled,
	);
}
async function extractAudio(
	videoId: string,
	userId: string,
	video: typeof videos.$inferSelect,
	tempAudioFilename?: string,
	sourceKeyOverride?: string,
): Promise<ExtractedAudio | null> {
	"use step";
	tempAudioFilename ??= transcriptionAudioFilename(video);

	const [bucket] = await Storage.getAccessForVideo(
		decodeStorageVideo(video),
	).pipe(runWorkflowPromise);

	let videoUrl: string;
	try {
		videoUrl = await resolveVideoSourceUrl(
			videoId,
			userId,
			video,
			sourceKeyOverride,
		);
	} catch (error) {
		// Instant-mode recordings can be transcribed straight from their uploaded
		// audio segments when no muxed source exists (self-hosted deployments
		// without a media server never produce a result.mp4 at all).
		if (
			!sourceKeyOverride &&
			(video.source.type === "desktopSegments" ||
				video.source.type === "desktopMP4")
		) {
			const segments = await extractAudioFromSegmentsImpl(
				videoId,
				userId,
				video,
				tempAudioFilename,
			);
			if (segments.status === "ok")
				return { audioUrl: segments.audioUrl, durationMs: segments.durationMs };
			if (segments.status === "no-audio") return null;
			console.warn(
				`[transcribe] Segments audio fallback unavailable for ${videoId}: ${segments.reason}`,
			);
		}
		throw error;
	}

	const useMediaServer = isMediaServerConfigured();
	console.log(
		`[transcribe] Audio detection: useMediaServer=${useMediaServer}, videoId=${videoId}`,
	);

	let hasAudio: boolean;
	let audioBuffer: Buffer;
	let durationMs: number | undefined;

	if (useMediaServer) {
		try {
			const probe = await probeVideoViaMediaServer(videoUrl);
			durationMs = durationMilliseconds(probe.duration);
			console.log(
				`[transcribe] Probe result for ${videoId}: audioCodec=${probe.audioCodec}, videoCodec=${probe.videoCodec}, duration=${probe.duration}, audioChannels=${probe.audioChannels}, sampleRate=${probe.sampleRate}`,
			);
			hasAudio = probe.audioCodec !== null;
		} catch (probeError) {
			console.error(
				`[transcribe] Probe failed for ${videoId}, falling back to audio check:`,
				probeError,
			);
			hasAudio = await checkHasAudioTrackViaMediaServer(videoUrl);
			console.log(
				`[transcribe] Fallback audio check result for ${videoId}: hasAudio=${hasAudio}`,
			);
		}

		if (!hasAudio) {
			console.log(
				`[transcribe] No audio track detected for ${videoId} via media server`,
			);
			return null;
		}

		audioBuffer = await extractAudioViaMediaServer(videoUrl);
	} else {
		hasAudio = await checkHasAudioTrack(videoUrl);
		console.log(
			`[transcribe] Local ffmpeg audio check for ${videoId}: hasAudio=${hasAudio}`,
		);
		if (!hasAudio) {
			return null;
		}

		const result = await extractAudioFromUrl(videoUrl);

		try {
			audioBuffer = await fs.readFile(result.filePath);
		} finally {
			await result.cleanup();
		}
	}

	console.log(
		`[transcribe] Extracted audio for ${videoId}: ${audioBuffer.length} bytes`,
	);

	const audioKey = `${userId}/${videoId}/${tempAudioFilename}`;

	await bucket
		.putObject(audioKey, audioBuffer, {
			contentType: "audio/mpeg",
		})
		.pipe(runWorkflowPromise);

	const audioSignedUrl = await bucket
		.getInternalSignedObjectUrl(audioKey)
		.pipe(runWorkflowPromise);

	return { audioUrl: audioSignedUrl, durationMs };
}

async function resolveVideoSourceUrl(
	videoId: string,
	userId: string,
	video: typeof videos.$inferSelect,
	sourceKeyOverride?: string,
): Promise<string> {
	const [resolvedBucket] = await Storage.getAccessForVideo(
		decodeStorageVideo(video),
	).pipe(runWorkflowPromise);

	const upload = await db()
		.select({ rawFileKey: videoUploads.rawFileKey })
		.from(videoUploads)
		.where(eq(videoUploads.videoId, videoId as Video.VideoId))
		.limit(1);

	const candidateKeys = [
		sourceKeyOverride,
		`${userId}/${videoId}/result.mp4`,
		upload[0]?.rawFileKey,
	].filter(
		(value, index, values): value is string =>
			Boolean(value) && values.indexOf(value) === index,
	);

	for (const key of candidateKeys) {
		const url = await resolvedBucket
			.getInternalSignedObjectUrl(key)
			.pipe(runWorkflowPromise);
		const response = await fetch(url, {
			method: "GET",
			headers: { range: "bytes=0-0" },
		});

		if (response.ok) {
			console.log(`[transcribe] Using video source ${key}`);
			return url;
		}
	}

	throw new Error("Video file not accessible");
}

type SegmentsAudioExtraction =
	| { status: "ok"; audioUrl: string; durationMs: number }
	| { status: "no-audio" }
	| { status: "unavailable"; reason: string };

async function extractAudioFromSegmentsStep(
	videoId: string,
	userId: string,
	video: typeof videos.$inferSelect,
): Promise<SegmentsAudioExtraction> {
	"use step";

	return extractAudioFromSegmentsImpl(videoId, userId, video);
}

/**
 * Build the transcription audio input straight from the recording's uploaded
 * fMP4 audio segments (init.mp4 + segment_*.m4s byte-concatenate into a valid
 * fragmented MP4). Never throws: any failure reports "unavailable" so callers
 * can fall back to the muxed result.mp4 path instead of erroring the video.
 */
async function extractAudioFromSegmentsImpl(
	videoId: string,
	userId: string,
	video: typeof videos.$inferSelect,
	tempAudioFilename = transcriptionAudioFilename(video),
): Promise<SegmentsAudioExtraction> {
	try {
		const [bucket] = await Storage.getAccessForVideo(
			decodeStorageVideo(video),
		).pipe(runWorkflowPromise);

		const segSource = new Video.SegmentsSource({
			videoId,
			ownerId: video.ownerId,
		});

		const manifestContent = await bucket
			.getObject(segSource.getManifestKey())
			.pipe(runWorkflowPromise);
		const manifestJson = Option.getOrNull(manifestContent);
		if (!manifestJson) {
			return { status: "unavailable", reason: "segment manifest not found" };
		}

		let parsed: unknown;
		try {
			parsed = JSON.parse(manifestJson);
		} catch {
			return { status: "unavailable", reason: "invalid segment manifest JSON" };
		}

		const decoded = Schema.decodeUnknownEither(Video.SegmentManifest)(parsed);
		if (Either.isLeft(decoded)) {
			return {
				status: "unavailable",
				reason: "invalid segment manifest format",
			};
		}
		const manifest = decoded.right;

		const plan = planSegmentsAudioExtraction(manifest);
		if (plan.status !== "ok") return plan;

		const segmentUrls = await Promise.all([
			bucket
				.getInternalSignedObjectUrl(segSource.getAudioInitKey())
				.pipe(runWorkflowPromise),
			...plan.entries.map((entry) =>
				bucket
					.getInternalSignedObjectUrl(segSource.getAudioSegmentKey(entry.index))
					.pipe(runWorkflowPromise),
			),
		]);

		const concatPath = join(tmpdir(), `segments-audio-${randomUUID()}.mp4`);
		try {
			const totalBytes = await downloadConcatenatedSegments(
				segmentUrls,
				concatPath,
			);
			console.log(
				`[transcribe] Assembled ${plan.entries.length} audio segments (${totalBytes} bytes) for ${videoId}`,
			);

			// The concatenated init + fragments form a valid fragmented MP4 that
			// AssemblyAI ingests directly — no transcode, and no ffmpeg binary
			// (which is not available in the serverless runtime). The temp object
			// keeps the same key regardless of container so cleanupTempAudio's
			// contract is untouched.
			const audioBuffer = await fs.readFile(concatPath);

			const audioKey = `${userId}/${videoId}/${tempAudioFilename}`;
			await bucket
				.putObject(audioKey, audioBuffer, {
					contentType: "audio/mp4",
				})
				.pipe(runWorkflowPromise);

			const audioSignedUrl = await bucket
				.getInternalSignedObjectUrl(audioKey)
				.pipe(runWorkflowPromise);

			return {
				status: "ok",
				audioUrl: audioSignedUrl,
				durationMs: plan.totalDurationMs,
			};
		} finally {
			await fs.unlink(concatPath).catch(() => {});
		}
	} catch (error) {
		return {
			status: "unavailable",
			reason: error instanceof Error ? error.message : String(error),
		};
	}
}

async function transcribeWithProvider(
	audioUrl: string,
	language: AiGenerationLanguage,
	videoDurationMs: number,
): Promise<TranscriptionArtifacts> {
	"use step";

	const audioResponse = await fetch(audioUrl);
	if (!audioResponse.ok) {
		throw new Error(
			`Audio URL not accessible: ${audioResponse.status} ${audioResponse.statusText}`,
		);
	}

	const audioBuffer = Buffer.from(await audioResponse.arrayBuffer());
	const transcript = await transcribeAudio(
		audioBuffer,
		language,
		audioResponse.headers?.get("content-type") ?? "audio/mpeg",
		videoDurationMs > 0 ? videoDurationMs : undefined,
	);

	console.log(
		`[transcribe] Transcript ${transcript.id} finished with status=${transcript.status}, model=${transcript.speech_model_used ?? "unknown"}`,
	);

	if (transcript.status === "error") {
		const transcriptError = transcript.error ?? "Unknown error";
		const message = `Transcription failed (id=${transcript.id}, language=${language}): ${transcriptError}`;

		if (transcriptError.toLowerCase().includes("no spoken audio")) {
			throw new FatalError(message);
		}

		throw new Error(message);
	}

	// One paid pass produces both artifacts: the immutable word transcript (in
	// the original media timeline) and the caption VTT derived from those words.
	const durationMs =
		videoDurationMs > 0
			? videoDurationMs
			: (transcript.audio_duration ?? 0) * 1000;
	const editTranscript = createEditTranscript(transcript, durationMs);

	return {
		vtt: editTranscriptWordsToCaptionVtt(editTranscript.words),
		editTranscript: serializeEditTranscript(editTranscript),
	};
}

async function transcribeEditTranscriptWithProvider(
	audioUrl: string,
	videoDurationSeconds: number,
): Promise<string> {
	"use step";

	const audioResponse = await fetch(audioUrl);
	if (!audioResponse.ok) {
		throw new Error(
			`Audio URL not accessible: ${audioResponse.status} ${audioResponse.statusText}`,
		);
	}

	const audioBuffer = Buffer.from(await audioResponse.arrayBuffer());
	const transcript = await transcribeAudio(
		audioBuffer,
		"auto",
		audioResponse.headers?.get("content-type") ?? "audio/mpeg",
		videoDurationSeconds > 0 ? videoDurationSeconds * 1000 : undefined,
	);

	console.log(
		`[transcribe] Editable transcript ${transcript.id} finished with status=${transcript.status}, model=${transcript.speech_model_used ?? "unknown"}`,
	);

	if (transcript.status === "error") {
		throw new Error(
			`Editable transcription failed (id=${transcript.id}): ${transcript.error ?? "Unknown error"}`,
		);
	}

	const durationMs =
		videoDurationSeconds > 0
			? videoDurationSeconds * 1000
			: (transcript.audio_duration ?? 0) * 1000;
	return serializeEditTranscript(createEditTranscript(transcript, durationMs));
}

async function saveTranscription(
	videoId: string,
	userId: string,
	video: typeof videos.$inferSelect,
	transcription: TranscriptionArtifacts,
): Promise<boolean> {
	"use step";
	if (video.id !== videoId || video.ownerId !== userId)
		throw new FatalError("Transcription owner changed");
	const [bucket] = await Storage.getAccessForVideo(
		decodeStorageVideo(video),
	).pipe(runWorkflowPromise);
	const store = {
		getText: async (key: string) =>
			Option.getOrNull(await bucket.getObject(key).pipe(runWorkflowPromise)),
		put: (key: string, value: string, contentType: string) =>
			bucket.putObject(key, value, { contentType }).pipe(runWorkflowPromise),
		delete: (key: string) => bucket.deleteObject(key).pipe(runWorkflowPromise),
	};
	const [edit] = await db()
		.select({ sourceKey: videoEdits.sourceKey, editSpec: videoEdits.editSpec })
		.from(videoEdits)
		.where(eq(videoEdits.videoId, video.id));
	const original = edit
		? await readOriginalEditTranscript(video, store)
		: transcription.editTranscript;
	const prepared = await prepareTranscriptPublication({
		video,
		store,
		vtt: transcription.vtt,
		editTranscript: original,
	});
	const database = db();
	try {
		return await atomic(database, async (snapshot) => {
			const [current] = await snapshot.read((reader) =>
				reader.select().from(videos).where(eq(videos.id, video.id)).limit(1),
			);
			if (!current || current.ownerId !== video.ownerId)
				throw new TranscriptPublicationConflictError();
			const organization = current.orgId
				? await requireActiveOrganization(snapshot, current.orgId)
				: null;
			if (
				transcriptMediaRevision(current) === transcriptMediaRevision(video) &&
				current.transcriptionStatus === "COMPLETE" &&
				getTranscriptPublication(current)?.revision ===
					prepared.pointer.revision
			)
				return { statements: [], result: true };
			const [currentEdit] = await snapshot.read((reader) =>
				reader
					.select({
						sourceKey: videoEdits.sourceKey,
						editSpec: videoEdits.editSpec,
					})
					.from(videoEdits)
					.where(eq(videoEdits.videoId, video.id)),
			);
			if (JSON.stringify(currentEdit ?? null) !== JSON.stringify(edit ?? null))
				throw new TranscriptPublicationConflictError();
			const { liveTranscript: _liveTranscript, ...nextMetadata } =
				current.metadata ?? {};
			const metadata = metadataWithTranscriptPublication(
				current,
				prepared,
				nextMetadata,
			);
			if (
				current.settings?.disableTranscript ??
				organization?.settings?.disableTranscript
			)
				return {
					statements: [
						database
							.update(videos)
							.set({ metadata: nextMetadata, transcriptionStatus: "SKIPPED" })
							.where(eq(videos.id, video.id)),
					],
					result: false,
				};
			return {
				statements: [
					database
						.update(videos)
						.set({ metadata, transcriptionStatus: "COMPLETE" })
						.where(eq(videos.id, video.id)),
				],
				result: true,
			};
		});
	} catch (error) {
		const outcome = await readTranscriptPublicationOutcome(database, prepared);
		if (outcome.state === "published") return true;
		throw error;
	}
}

async function saveEditTranscriptBackfill(
	videoId: string,
	userId: string,
	requestId: string,
	video: typeof videos.$inferSelect,
	editTranscript: string,
) {
	"use step";
	if (!(await canPersistEditTranscriptBackfill(videoId, requestId, video)))
		return;
	const [base] = await db()
		.select()
		.from(videos)
		.where(eq(videos.id, video.id))
		.limit(1);
	if (
		!base ||
		base.ownerId !== userId ||
		transcriptMediaRevision(base) !== transcriptMediaRevision(video)
	)
		return;
	const [bucket] = await Storage.getAccessForVideo(
		decodeStorageVideo(base),
	).pipe(runWorkflowPromise);
	const store = {
		getText: async (key: string) =>
			Option.getOrNull(await bucket.getObject(key).pipe(runWorkflowPromise)),
		put: (key: string, value: string, contentType: string) =>
			bucket.putObject(key, value, { contentType }).pipe(runWorkflowPromise),
		delete: (key: string) => bucket.deleteObject(key).pipe(runWorkflowPromise),
	};
	const vtt = await readTranscriptVtt(base, store);
	const prepared = await prepareTranscriptPublication({
		video: base,
		store,
		vtt,
		editTranscript,
	});
	const database = db();
	try {
		await atomic(database, async (snapshot) => {
			const [current] = await snapshot.read((reader) =>
				reader.select().from(videos).where(eq(videos.id, video.id)).limit(1),
			);
			const [upload] = await snapshot.read((reader) =>
				reader
					.select({ videoId: videoUploads.videoId })
					.from(videoUploads)
					.where(eq(videoUploads.videoId, video.id))
					.limit(1),
			);
			if (
				!current ||
				current.ownerId !== userId ||
				current.transcriptionStatus !== "COMPLETE" ||
				upload ||
				getEditTranscriptBackfillStatus(current.metadata)?.requestId !==
					requestId ||
				transcriptMediaRevision(current) !== transcriptMediaRevision(video)
			)
				throw new TranscriptPublicationConflictError();
			if (current.orgId)
				await requireActiveOrganization(snapshot, current.orgId);
			const { editTranscriptBackfill: _backfill, ...nextMetadata } =
				current.metadata ?? {};
			return {
				statements: [
					database
						.update(videos)
						.set({
							metadata: metadataWithTranscriptPublication(
								current,
								prepared,
								nextMetadata,
							),
							updatedAt: current.updatedAt,
						})
						.where(eq(videos.id, current.id)),
				],
				result: undefined,
			};
		});
	} catch (error) {
		if (
			(await readTranscriptPublicationOutcome(database, prepared)).state ===
			"published"
		)
			return;
		throw error;
	}
}
async function saveEditTranscriptBackfillError(
	videoId: string,
	requestId: string,
	video: typeof videos.$inferSelect,
) {
	"use step";
	const database = db();
	await atomic(database, async (snapshot) => {
		const [current] = await snapshot.read((reader) =>
			reader
				.select()
				.from(videos)
				.where(eq(videos.id, videoId as Video.VideoId))
				.limit(1),
		);
		const status = getEditTranscriptBackfillStatus(current?.metadata);
		if (
			!current ||
			current.ownerId !== video.ownerId ||
			status?.requestId !== requestId ||
			transcriptMediaRevision(current) !== transcriptMediaRevision(video)
		)
			return { statements: [], result: undefined };
		return {
			statements: [
				database
					.update(videos)
					.set({
						metadata: {
							...current.metadata,
							editTranscriptBackfill: { ...status, status: "error" },
						},
						updatedAt: current.updatedAt,
					})
					.where(eq(videos.id, current.id)),
			],
			result: undefined,
		};
	});
}
async function canPersistEditTranscriptBackfill(
	videoId: string,
	requestId: string,
	video: typeof videos.$inferSelect,
) {
	const [[currentVideo], [activeUpload]] = await Promise.all([
		db()
			.select()
			.from(videos)
			.where(eq(videos.id, videoId as Video.VideoId)),
		db()
			.select({ phase: videoUploads.phase })
			.from(videoUploads)
			.where(eq(videoUploads.videoId, videoId as Video.VideoId))
			.limit(1),
	]);

	return (
		currentVideo?.transcriptionStatus === "COMPLETE" &&
		currentVideo.duration === video.duration &&
		transcriptMediaRevision(currentVideo) === transcriptMediaRevision(video) &&
		getEditTranscriptBackfillStatus(currentVideo.metadata)?.requestId ===
			requestId &&
		!activeUpload
	);
}

async function cleanupTempAudio(
	videoId: string,
	userId: string,
	video: typeof videos.$inferSelect,
	tempAudioFilename?: string,
): Promise<void> {
	"use step";
	tempAudioFilename ??= transcriptionAudioFilename(video);

	const audioKey = `${userId}/${videoId}/${tempAudioFilename}`;

	try {
		const [bucket] = await Storage.getAccessForVideo(
			decodeStorageVideo(video),
		).pipe(runWorkflowPromise);

		await bucket.deleteObject(audioKey).pipe(runWorkflowPromise);
	} catch (error) {
		console.error(
			`[transcribe] Failed to cleanup temp audio file: ${audioKey}`,
			error,
		);
	}
}

async function queueAiGeneration(
	videoId: string,
	userId: string,
): Promise<void> {
	"use step";

	await startAiGeneration(videoId as Video.VideoId, userId);
}

async function _markEnhancedAudioProcessing(videoId: string): Promise<void> {
	"use step";

	await db()
		.update(videos)
		.set({
			metadata: sql`json_set(coalesce(${videos.metadata}, json_object()), '$.enhancedAudioStatus', 'PROCESSING')`,
		})
		.where(eq(videos.id, videoId as Video.VideoId));
}

async function _enhanceAndSaveAudio(
	videoId: string,
	userId: string,
	audioUrl: string,
	video: typeof videos.$inferSelect,
): Promise<void> {
	"use step";

	console.log(`[transcribe] Starting audio enhancement for video ${videoId}`);

	try {
		const enhancedBuffer = await enhanceAudioFromUrl(audioUrl);
		console.log(
			`[transcribe] Audio enhanced, saving to S3 (${enhancedBuffer.length} bytes)`,
		);

		const [bucket] = await Storage.getAccessForVideo(
			decodeStorageVideo(video),
		).pipe(runWorkflowPromise);

		const enhancedAudioKey = `${userId}/${videoId}/enhanced-audio.${ENHANCED_AUDIO_EXTENSION}`;

		await bucket
			.putObject(enhancedAudioKey, enhancedBuffer, {
				contentType: ENHANCED_AUDIO_CONTENT_TYPE,
			})
			.pipe(runWorkflowPromise);

		await db()
			.update(videos)
			.set({
				metadata: sql`json_set(coalesce(${videos.metadata}, json_object()), '$.enhancedAudioStatus', 'COMPLETE')`,
			})
			.where(eq(videos.id, videoId as Video.VideoId));
	} catch (error) {
		console.error(
			`[transcribe] Audio enhancement failed for video ${videoId}:`,
			error,
		);

		await db()
			.update(videos)
			.set({
				metadata: sql`json_set(coalesce(${videos.metadata}, json_object()), '$.enhancedAudioStatus', 'ERROR')`,
			})
			.where(eq(videos.id, videoId as Video.VideoId));
	}
}
