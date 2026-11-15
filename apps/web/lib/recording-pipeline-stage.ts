import type { VideoMetadata } from "@cap/database/types";

export type RecordingPipelineStage =
	| "finalizing"
	| "transcribing"
	| "cleaning"
	| "titling";

type Timestamp = Date | number | string | null | undefined;

export type RecordingPipelineInput = {
	isScreenshot?: boolean | null;
	transcriptionStatus?: string | null;
	metadata?: VideoMetadata | null;
	updatedAt?: Timestamp;
	finalizationState?: string | null;
	finalizationUpdatedAt?: Timestamp;
};

const MINUTE = 60_000;
const ACTIVE_STEP_WINDOW = 60 * MINUTE;
const HANDOFF_WINDOW = 10 * MINUTE;
const ACTIVE_FINALIZATION_STATES = new Set([
	"committing",
	"queued",
	"processing",
	"retry",
]);

function toMilliseconds(value: Timestamp) {
	if (value === null || value === undefined) return null;
	const time =
		value instanceof Date
			? value.getTime()
			: typeof value === "number"
				? value
				: Date.parse(value);
	return Number.isFinite(time) ? time : null;
}

function isRecent(value: Timestamp, windowMs: number, now: number) {
	const time = toMilliseconds(value);
	return time !== null && now - time < windowMs;
}

/**
 * Describes the automatic work still running on a recording after its upload:
 * finalization, transcription, the AI title and summary, then automatic
 * cleanup. The title is written from the finished transcript while cleanup is
 * prepared, and cleanup keeps it, so the title stage comes first and is short.
 * Every stage is bounded by the time of its last recorded activity so an
 * abandoned or failed run cannot leave a card marked as processing forever.
 */
export function getRecordingPipelineStage(
	input: RecordingPipelineInput,
	now: number = Date.now(),
): RecordingPipelineStage | null {
	if (input.isScreenshot) return null;
	const metadata = input.metadata ?? {};
	const cleanup = metadata.automaticCleanup;
	const status = input.transcriptionStatus ?? null;
	const cleaning =
		cleanup?.status === "processing" &&
		isRecent(cleanup.operation?.startedAt, ACTIVE_STEP_WINDOW, now);

	if (status === "PROCESSING") {
		if (cleaning) return "cleaning";
		return isRecent(
			metadata.transcriptionRun?.requestedAt ?? input.updatedAt,
			ACTIVE_STEP_WINDOW,
			now,
		)
			? "transcribing"
			: null;
	}

	if (status === "COMPLETE") {
		const ai = metadata.aiGenerationStatus;
		if (
			(ai === "QUEUED" || ai === "PROCESSING") &&
			isRecent(
				metadata.aiGenerationRun?.requestedAt ?? input.updatedAt,
				ACTIVE_STEP_WINDOW,
				now,
			)
		)
			return "titling";
		if (cleaning) return "cleaning";
		if (ai === "QUEUED" || ai === "PROCESSING") return null;
		if (cleanup?.status === "processing") return null;

		const transcriptRequestedAt = metadata.transcriptionRun?.requestedAt;
		const handoff =
			(!transcriptRequestedAt ||
				isRecent(transcriptRequestedAt, ACTIVE_STEP_WINDOW, now)) &&
			isRecent(input.updatedAt, HANDOFF_WINDOW, now);
		const hasAiOutput = Boolean(
			ai || metadata.aiTitle || metadata.summary || metadata.chapters?.length,
		);

		// Cleanup has run (or an edit replaced it): only a title that still
		// has to be written after the cut keeps the card busy.
		if (cleanup || metadata.completedVideoEdit)
			return !hasAiOutput && handoff ? "titling" : null;

		// Cleanup has not claimed the recording yet. Without any AI output the
		// title is next; with it, the cut is being prepared. An older recording
		// without a recorded transcription run never reaches cleanup this way.
		if (!hasAiOutput) return handoff ? "titling" : null;
		return transcriptRequestedAt &&
			metadata.transcriptPublication?.edit &&
			handoff
			? "cleaning"
			: null;
	}

	if (status === null) {
		const state = input.finalizationState;
		if (!state) return null;
		if (ACTIVE_FINALIZATION_STATES.has(state))
			return isRecent(input.finalizationUpdatedAt, ACTIVE_STEP_WINDOW, now)
				? "finalizing"
				: null;
		if (state === "verified")
			return isRecent(input.finalizationUpdatedAt, HANDOFF_WINDOW, now)
				? "transcribing"
				: null;
	}

	return cleaning ? "cleaning" : null;
}

export function getRecordingPipelineLabel(stage: RecordingPipelineStage) {
	switch (stage) {
		case "finalizing":
			return "Processing: finishing upload";
		case "transcribing":
			return "Processing: transcribing";
		case "cleaning":
			return "Processing: removing pauses and fillers";
		case "titling":
			return "Processing: writing title and summary";
	}
}
