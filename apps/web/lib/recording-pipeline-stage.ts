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
 * finalization, transcription, automatic cleanup, then the AI title and
 * summary. Every stage is bounded by the time of its last recorded activity so
 * an abandoned or failed run cannot leave a card marked as processing forever.
 */
export function getRecordingPipelineStage(
	input: RecordingPipelineInput,
	now: number = Date.now(),
): RecordingPipelineStage | null {
	if (input.isScreenshot) return null;
	const metadata = input.metadata ?? {};
	const cleanup = metadata.automaticCleanup;

	if (cleanup?.status === "processing")
		return isRecent(cleanup.operation?.startedAt, ACTIVE_STEP_WINDOW, now)
			? "cleaning"
			: null;

	const status = input.transcriptionStatus ?? null;

	if (status === "PROCESSING")
		return isRecent(
			metadata.transcriptionRun?.requestedAt ?? input.updatedAt,
			ACTIVE_STEP_WINDOW,
			now,
		)
			? "transcribing"
			: null;

	if (status === "COMPLETE") {
		const ai = metadata.aiGenerationStatus;
		if (ai === "QUEUED" || ai === "PROCESSING")
			return isRecent(
				metadata.aiGenerationRun?.requestedAt ?? input.updatedAt,
				ACTIVE_STEP_WINDOW,
				now,
			)
				? "titling"
				: null;
		if (ai || metadata.aiTitle || metadata.summary || metadata.chapters?.length)
			return null;
		const transcriptRequestedAt = metadata.transcriptionRun?.requestedAt;
		if (
			transcriptRequestedAt &&
			!isRecent(transcriptRequestedAt, ACTIVE_STEP_WINDOW, now)
		)
			return null;
		if (!isRecent(input.updatedAt, HANDOFF_WINDOW, now)) return null;
		return cleanup ? "titling" : "cleaning";
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

	return null;
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
