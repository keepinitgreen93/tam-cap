import { db } from "@cap/database/cloudflare/application";
import { organizations, users, videos } from "@cap/database/cloudflare/schema";
import { serverEnv } from "@cap/env";
import { Storage } from "@cap/web-backend/src/Storage/index";
import {
	type AiGenerationLanguage,
	parseAiGenerationLanguage,
	type User,
	Video,
} from "@cap/web-domain";
import { and, eq, sql } from "drizzle-orm";
import { Either, Option, Schema } from "effect";
import { isAiGenerationEnabledForUser } from "@/lib/ai-generation-entitlement";
import { ASSEMBLYAI_SUPPORTED_LANGUAGES } from "@/lib/assemblyai";

import {
	applyChunkToLiveTranscript,
	createEmptyLiveTranscript,
	getLiveTranscriptObjectKey,
	isNoSpokenAudioError,
	LIVE_TRANSCRIBE,
	LIVE_TRANSCRIPT_NO_SEGMENTS,
	type LiveTranscriptState,
	offsetChunkWords,
	parseLiveTranscript,
	planNextLiveChunk,
} from "@/lib/live-transcribe-core";
import { downloadConcatenatedSegmentsToBuffer } from "@/lib/segments-audio-download";
import { transcribeVideo } from "@/lib/transcribe";
import { isTranscriptionConfigured } from "@/lib/transcription-config";
import { transcribeAudio } from "@/lib/transcription-provider";
import { decodeStorageVideo } from "@/lib/video-storage";
import { runWorkflowPromise } from "@/lib/workflow-runtime";

interface LiveTranscribeWorkflowPayload {
	runId: string;
	videoId: string;
	userId: string;
}

type InitResult =
	| { ok: false; reason: string }
	| {
			ok: true;
			lastAudioSegmentIndex: number;
			transcribedDurationMs: number;
			languageCode: string | null;
			orgLanguage: AiGenerationLanguage;
	  };

type ChunkStepResult =
	| {
			outcome: "chunk";
			lastAudioSegmentIndex: number;
			transcribedDurationMs: number;
			languageCode: string | null;
			/** This chunk was the recording's final one: the manifest is complete
			 * and coverage is now full, so promotion can start immediately
			 * without another poll round-trip. */
			recordingComplete?: boolean;
	  }
	| { outcome: "chunk-failed"; failedAtIndex: number; reason: string }
	| { outcome: "waiting" }
	| { outcome: "done" }
	| { outcome: "no-audio" }
	| { outcome: "canonical-done" }
	| { outcome: "gone" };

export async function liveTranscribeWorkflow(
	payload: LiveTranscribeWorkflowPayload,
) {
	"use workflow";

	const { videoId, userId, runId } = payload;

	const init = await initLiveTranscription(videoId, userId, runId);
	if (!init.ok) {
		await finishLiveTranscription(videoId, userId, "stopped", runId);
		return {
			success: true,
			message: `Live transcription skipped: ${init.reason}`,
		};
	}

	let lastIndex = init.lastAudioSegmentIndex;
	let transcribedMs = init.transcribedDurationMs;
	let languageCode = init.languageCode;
	let chunkCount = 0;
	let idleSteps = 0;
	let failuresAtIndex = 0;
	let outcome = "chunk-limit";

	try {
		while (chunkCount < LIVE_TRANSCRIBE.MAX_CHUNKS) {
			if (transcribedMs >= LIVE_TRANSCRIBE.MAX_TRANSCRIBED_SECONDS * 1000) {
				outcome = "budget-exhausted";
				break;
			}

			const targetSeconds =
				chunkCount < LIVE_TRANSCRIBE.GROW_AFTER_CHUNKS
					? LIVE_TRANSCRIBE.INITIAL_CHUNK_SECONDS
					: LIVE_TRANSCRIBE.MAX_CHUNK_SECONDS;

			const result = await processNextLiveChunk({
				videoId,
				userId,
				runId,
				lastProcessedIndex: lastIndex,
				targetSeconds,
				language: languageCode ?? init.orgLanguage,
				// After repeated failures the chunk is skipped: advance past it and
				// leave a gap for the canonical transcription to fill.
				skipPastFailedChunk:
					failuresAtIndex >= LIVE_TRANSCRIBE.MAX_CHUNK_ATTEMPTS,
			});

			if (result.outcome === "chunk") {
				lastIndex = result.lastAudioSegmentIndex;
				transcribedMs = result.transcribedDurationMs;
				languageCode = languageCode ?? result.languageCode;
				chunkCount++;
				idleSteps = 0;
				failuresAtIndex = 0;
				if (result.recordingComplete) {
					outcome = "done";
					break;
				}
				continue;
			}

			if (result.outcome === "chunk-failed") {
				failuresAtIndex++;
				// Skip attempts also count here; if even recording the gap keeps
				// failing, storage is degraded — stop rather than spin.
				if (failuresAtIndex >= LIVE_TRANSCRIBE.MAX_CHUNK_ATTEMPTS * 3) {
					outcome = "chunk-abandoned";
					break;
				}
				continue;
			}

			if (result.outcome === "waiting") {
				idleSteps++;
				if (idleSteps >= LIVE_TRANSCRIBE.MAX_IDLE_STEPS) {
					outcome = "stalled";
					break;
				}
				continue;
			}

			outcome = result.outcome;
			break;
		}
	} catch (error) {
		// A step exhausted its retries; make sure the artifact and metadata
		// never advertise a live transcription that is no longer running.
		await finishLiveTranscription(videoId, userId, "stopped", runId);
		throw error;
	}

	if (outcome === "done") {
		const promotion = await promoteLiveTranscript(videoId, userId, runId);
		if (promotion.promoted) {
			return {
				success: true,
				message: "Live transcription promoted to canonical",
			};
		}
		console.warn(
			`[liveTranscribe] Promotion declined for ${videoId}: ${promotion.reason}`,
		);
	}

	await finishLiveTranscription(
		videoId,
		userId,
		outcome === "done" ? "complete" : "stopped",
		runId,
	);

	return { success: true, message: `Live transcription ${outcome}` };
}

async function initLiveTranscription(
	videoId: string,
	userId: string,
	runId: string,
): Promise<InitResult> {
	"use step";

	if (!isTranscriptionConfigured(serverEnv())) {
		return { ok: false, reason: "missing transcription provider credentials" };
	}

	const [row] = await db()
		.select({ video: videos, orgSettings: organizations.settings })
		.from(videos)
		.leftJoin(organizations, eq(videos.orgId, organizations.id))
		.where(eq(videos.id, videoId as Video.VideoId));

	if (
		!row?.video ||
		row.video.ownerId !== userId ||
		row.video.metadata?.liveTranscript?.id !== runId
	) {
		return { ok: false, reason: "video not found" };
	}
	if (row.video.source.type !== "desktopSegments") {
		return { ok: false, reason: "not a segmented recording" };
	}
	if (
		row.video.settings?.disableTranscript ??
		row.orgSettings?.disableTranscript
	) {
		return { ok: false, reason: "transcription disabled" };
	}
	if (row.video.transcriptionStatus === "COMPLETE") {
		return { ok: false, reason: "canonical transcript already exists" };
	}

	// Resume from a previous run's artifact after a crash/redeploy so already
	// paid-for chunks are never re-transcribed.
	let lastAudioSegmentIndex = LIVE_TRANSCRIPT_NO_SEGMENTS;
	let transcribedDurationMs = 0;
	let languageCode: string | null = null;
	try {
		const [bucket] = await Storage.getAccessForVideo(
			decodeStorageVideo(row.video),
		).pipe(runWorkflowPromise);
		const existing = await bucket
			.getObject(getLiveTranscriptObjectKey(row.video.ownerId, videoId, runId))
			.pipe(runWorkflowPromise);
		const artifact = Option.isSome(existing)
			? parseLiveTranscript(existing.value)
			: null;
		if (artifact) {
			lastAudioSegmentIndex = artifact.lastAudioSegmentIndex;
			transcribedDurationMs = artifact.transcribedDurationMs;
			languageCode = artifact.languageCode;
		}
	} catch (error) {
		console.warn(
			`[liveTranscribe] Failed to read existing artifact for ${videoId}`,
			error,
		);
	}

	return {
		ok: true,
		lastAudioSegmentIndex,
		transcribedDurationMs,
		languageCode,
		orgLanguage: parseAiGenerationLanguage(
			row.orgSettings?.aiGenerationLanguage,
		),
	};
}

async function processNextLiveChunk(options: {
	runId: string;
	videoId: string;
	userId: string;
	lastProcessedIndex: number;
	targetSeconds: number;
	language: string;
	skipPastFailedChunk: boolean;
}): Promise<ChunkStepResult> {
	"use step";

	const { videoId, lastProcessedIndex, targetSeconds } = options;

	const [video] = await db()
		.select()
		.from(videos)
		.where(eq(videos.id, videoId as Video.VideoId));

	if (
		!video ||
		video.ownerId !== options.userId ||
		video.metadata?.liveTranscript?.id !== options.runId
	)
		return { outcome: "gone" };
	if (
		video.transcriptionStatus === "COMPLETE" ||
		video.transcriptionStatus === "SKIPPED" ||
		video.transcriptionStatus === "NO_AUDIO"
	) {
		// The canonical pipeline finished (or decided) while we were running;
		// everything from here on would be wasted spend.
		return { outcome: "canonical-done" };
	}
	if (video.settings?.disableTranscript) {
		return { outcome: "canonical-done" };
	}

	const [bucket] = await Storage.getAccessForVideo(
		decodeStorageVideo(video),
	).pipe(runWorkflowPromise);
	const segSource = new Video.SegmentsSource({
		videoId,
		ownerId: video.ownerId,
	});

	// Poll inside the step (same pattern as the mux-completion wait) so idle
	// time costs one held invocation, not hundreds of queued step dispatches.
	const pollDeadline = Date.now() + LIVE_TRANSCRIBE.MAX_POLL_MS_PER_STEP;
	let decision: ReturnType<typeof planNextLiveChunk> | null = null;
	let decodedManifest: Video.SegmentManifestType | null = null;

	while (Date.now() < pollDeadline) {
		const manifestContent = await bucket
			.getObject(segSource.getManifestKey())
			.pipe(runWorkflowPromise);
		const manifestJson = Option.getOrNull(manifestContent);

		if (manifestJson) {
			let parsed: unknown = null;
			try {
				parsed = JSON.parse(manifestJson);
			} catch {}
			const decoded = parsed
				? Schema.decodeUnknownEither(Video.SegmentManifest)(parsed)
				: null;

			if (decoded && Either.isRight(decoded)) {
				const next = planNextLiveChunk({
					manifest: decoded.right,
					lastProcessedIndex,
					targetSeconds,
				});
				if (next.action !== "wait") {
					decision = next;
					decodedManifest = decoded.right;
					break;
				}
			}
		}

		await new Promise((resolve) =>
			setTimeout(resolve, LIVE_TRANSCRIBE.POLL_INTERVAL_MS),
		);
	}

	if (!decision) return { outcome: "waiting" };
	if (decision.action === "done") return { outcome: "done" };
	if (decision.action === "no-audio") return { outcome: "no-audio" };
	if (decision.action !== "chunk") return { outcome: "waiting" };

	const chunkEndIndex =
		decision.entries[decision.entries.length - 1]?.index ?? lastProcessedIndex;

	if (options.skipPastFailedChunk) {
		console.warn(
			`[liveTranscribe] Skipping poison chunk ${lastProcessedIndex + 1}..${chunkEndIndex} for ${videoId}`,
		);
		// The gap MUST be durably recorded before the cursor advances, or a
		// later promotion could ship a transcript that silently misses speech.
		try {
			const artifactKey = getLiveTranscriptObjectKey(
				video.ownerId,
				videoId,
				options.runId,
			);
			const existing = await bucket
				.getObject(artifactKey)
				.pipe(runWorkflowPromise)
				.catch(() => Option.none<string>());
			const artifact =
				(Option.isSome(existing)
					? parseLiveTranscript(existing.value)
					: null) ?? createEmptyLiveTranscript(new Date().toISOString());
			await bucket
				.putObject(
					artifactKey,
					JSON.stringify({
						...artifact,
						hasGaps: true,
						lastAudioSegmentIndex: Math.max(
							artifact.lastAudioSegmentIndex,
							chunkEndIndex,
						),
						transcribedDurationMs: Math.max(
							artifact.transcribedDurationMs,
							decision.startMs + decision.durationMs,
						),
						updatedAt: new Date().toISOString(),
					}),
					{ contentType: "application/json" },
				)
				.pipe(runWorkflowPromise);
		} catch (error) {
			return {
				outcome: "chunk-failed",
				failedAtIndex: lastProcessedIndex,
				reason: `failed to record chunk gap: ${
					error instanceof Error ? error.message : String(error)
				}`,
			};
		}
		await touchLiveClaim(videoId, options.runId);
		return {
			outcome: "chunk",
			lastAudioSegmentIndex: chunkEndIndex,
			transcribedDurationMs: decision.startMs + decision.durationMs,
			languageCode: null,
		};
	}

	try {
		const segmentUrls = await Promise.all([
			bucket
				.getInternalSignedObjectUrl(segSource.getAudioInitKey())
				.pipe(runWorkflowPromise),
			...decision.entries.map((entry) =>
				bucket
					.getInternalSignedObjectUrl(segSource.getAudioSegmentKey(entry.index))
					.pipe(runWorkflowPromise),
			),
		]);

		// init + fragments concatenate into a valid fragmented MP4 that
		// AssemblyAI ingests directly (verified: full files, mid-stream chunks
		// with chunk-relative timestamps, and real desktop uploads). No local
		// ffmpeg — the binary doesn't exist in the serverless runtime.
		const audioBuffer = await downloadConcatenatedSegmentsToBuffer(segmentUrls);

		const language = (
			ASSEMBLYAI_SUPPORTED_LANGUAGES as readonly string[]
		).includes(options.language)
			? (options.language as AiGenerationLanguage)
			: ("auto" as AiGenerationLanguage);
		const transcript = await transcribeAudio(
			audioBuffer,
			language,
			"audio/mp4",
			decision.durationMs,
		);

		const noSpokenAudio = isNoSpokenAudioError(transcript);
		if (transcript.status === "error" && !noSpokenAudio) {
			throw new Error(transcript.error ?? "Transcription chunk failed");
		}

		const words = noSpokenAudio
			? []
			: offsetChunkWords(
					transcript.words,
					decision.startMs,
					decision.durationMs,
				);

		const artifactKey = getLiveTranscriptObjectKey(
			video.ownerId,
			videoId,
			options.runId,
		);
		const existing = await bucket
			.getObject(artifactKey)
			.pipe(runWorkflowPromise);
		const artifact =
			(Option.isSome(existing) ? parseLiveTranscript(existing.value) : null) ??
			createEmptyLiveTranscript(new Date().toISOString());

		const updated = applyChunkToLiveTranscript(artifact, {
			startMs: decision.startMs,
			durationMs: decision.durationMs,
			lastAudioSegmentIndex: chunkEndIndex,
			words,
			languageCode:
				typeof transcript.language_code === "string"
					? transcript.language_code
					: null,
			nowIso: new Date().toISOString(),
		});

		// Polling + the AssemblyAI round trip can take minutes; re-check that the
		// canonical pipeline didn't complete meanwhile, or this write would
		// re-create the artifact it just deleted (an orphan billed forever).
		const [current] = await db()
			.select({
				transcriptionStatus: videos.transcriptionStatus,
				metadata: videos.metadata,
				ownerId: videos.ownerId,
			})
			.from(videos)
			.where(eq(videos.id, videoId as Video.VideoId));
		if (
			current?.ownerId !== options.userId ||
			current?.metadata?.liveTranscript?.id !== options.runId ||
			current?.transcriptionStatus === "COMPLETE" ||
			current?.transcriptionStatus === "SKIPPED" ||
			current?.transcriptionStatus === "NO_AUDIO"
		) {
			return { outcome: "canonical-done" };
		}

		const body = JSON.stringify(updated);
		await bucket
			.putObject(artifactKey, body, { contentType: "application/json" })
			.pipe(runWorkflowPromise);

		// Freshness-stamp the claim so other transcription triggers (post-mux
		// webhook, share-page retries) keep deferring to this workflow.
		await touchLiveClaim(videoId, options.runId);

		// If this chunk completed full coverage of a finished recording, tell
		// the workflow to promote right away instead of paying another poll
		// round-trip - this latency is the stop-to-final-transcript feel.
		const next = decodedManifest
			? planNextLiveChunk({
					manifest: decodedManifest,
					lastProcessedIndex: chunkEndIndex,
					targetSeconds,
				})
			: ({ action: "wait" } as const);

		console.log(
			`[liveTranscribe] ${videoId} chunk ${lastProcessedIndex + 1}..${chunkEndIndex} (${decision.durationMs}ms, ${words.length} words)`,
		);

		return {
			outcome: "chunk",
			lastAudioSegmentIndex: chunkEndIndex,
			transcribedDurationMs: updated.transcribedDurationMs,
			languageCode: updated.languageCode,
			recordingComplete: next.action === "done",
		};
	} catch (error) {
		const reason = error instanceof Error ? error.message : String(error);
		console.warn(
			`[liveTranscribe] Chunk ${lastProcessedIndex + 1}..${chunkEndIndex} failed for ${videoId}: ${reason}`,
		);
		return {
			outcome: "chunk-failed",
			failedAtIndex: lastProcessedIndex,
			reason,
		};
	}
}

/**
 * Re-stamp the live claim's freshness so other transcription triggers keep
 * deferring to this workflow (lib/transcribe.ts checks the stamp age). A
 * no-op once the claim was cleared or finished.
 */
async function touchLiveClaim(videoId: string, runId: string): Promise<void> {
	try {
		await db()
			.update(videos)
			.set({
				metadata: sql`JSON_SET(COALESCE(${videos.metadata}, JSON_OBJECT()), '$.liveTranscript.updatedAt', ${new Date().toISOString()})`,
				updatedAt: sql`${videos.updatedAt}`,
			})
			.where(
				and(
					eq(videos.id, videoId as Video.VideoId),
					sql`json_extract(${videos.metadata}, '$.liveTranscript.status') = 'active'`,
					sql`json_extract(${videos.metadata}, '$.liveTranscript.id') = ${runId}`,
				),
			);
	} catch (error) {
		console.warn(
			`[liveTranscribe] Failed to stamp live claim for ${videoId}`,
			error,
		);
	}
}

type PromotionResult = { promoted: boolean; reason?: string };
async function promoteLiveTranscript(
	videoId: string,
	userId: string,
	runId: string,
): Promise<PromotionResult> {
	"use step";
	const [video] = await db()
		.select()
		.from(videos)
		.where(eq(videos.id, videoId as Video.VideoId));
	if (
		!video ||
		video.ownerId !== userId ||
		video.metadata?.liveTranscript?.id !== runId
	)
		return { promoted: false, reason: "live run superseded" };
	await queueFullPassFallback(videoId, userId);
	return {
		promoted: false,
		reason: "canonical publication requires verified full-pass provenance",
	};
}
/**
 * When promotion can't happen, immediately queue the normal full
 * transcription (early-from-segments) instead of waiting for the post-mux
 * queue, so a declined promotion costs seconds, not a minute.
 */
async function queueFullPassFallback(
	videoId: string,
	userId: string,
): Promise<void> {
	try {
		const [owner] = await db()
			.select({
				email: users.email,
				stripeSubscriptionStatus: users.stripeSubscriptionStatus,
				thirdPartyStripeSubscriptionId: users.thirdPartyStripeSubscriptionId,
			})
			.from(users)
			.where(eq(users.id, userId as User.UserId));

		await transcribeVideo(
			videoId as Video.VideoId,
			userId,
			isAiGenerationEnabledForUser(owner),
			{ earlyFromSegments: true },
		);
	} catch (error) {
		console.warn(
			`[liveTranscribe] Full-pass fallback queue failed for ${videoId}`,
			error,
		);
	}
}

async function finishLiveTranscription(
	videoId: string,
	userId: string,
	state: LiveTranscriptState,
	runId: string,
): Promise<void> {
	"use step";

	try {
		await db()
			.update(videos)
			.set({
				metadata: sql`JSON_SET(COALESCE(${videos.metadata}, JSON_OBJECT()), '$.liveTranscript.status', ${state}, '$.liveTranscript.updatedAt', ${new Date().toISOString()})`,
				updatedAt: sql`${videos.updatedAt}`,
			})
			.where(
				and(
					eq(videos.id, videoId as Video.VideoId),
					eq(videos.ownerId, userId as User.UserId),
					sql`json_extract(${videos.metadata}, '$.liveTranscript.id') = ${runId}`,
				),
			);
	} catch (error) {
		console.warn(
			`[liveTranscribe] Failed to update metadata for ${videoId}`,
			error,
		);
	}

	try {
		const [video] = await db()
			.select()
			.from(videos)
			.where(
				and(
					eq(videos.id, videoId as Video.VideoId),
					eq(videos.ownerId, userId as User.UserId),
					sql`json_extract(${videos.metadata}, '$.liveTranscript.id') = ${runId}`,
				),
			);
		if (
			!video ||
			video.ownerId !== userId ||
			video.metadata?.liveTranscript?.id !== runId
		)
			return;

		const [bucket] = await Storage.getAccessForVideo(
			decodeStorageVideo(video),
		).pipe(runWorkflowPromise);
		const artifactKey = getLiveTranscriptObjectKey(
			video.ownerId,
			videoId,
			runId,
		);
		const existing = await bucket
			.getObject(artifactKey)
			.pipe(runWorkflowPromise);
		if (Option.isNone(existing)) return;

		const artifact = parseLiveTranscript(existing.value);
		if (!artifact || artifact.state === state) return;

		await bucket
			.putObject(
				artifactKey,
				JSON.stringify({
					...artifact,
					state,
					updatedAt: new Date().toISOString(),
				}),
				{ contentType: "application/json" },
			)
			.pipe(runWorkflowPromise);
	} catch (error) {
		console.warn(
			`[liveTranscribe] Failed to finalize artifact for ${videoId}`,
			error,
		);
	}
}
