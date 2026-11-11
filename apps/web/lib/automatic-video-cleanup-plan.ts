import type { VideoEditSpec } from "@cap/database/types";
import {
	type EditTranscript,
	type EditTranscriptWord,
	planFillerCuts,
} from "@/lib/edit-transcript";
import { planSilenceCuts, type SilenceRange } from "@/lib/silence-cuts";
import {
	createIdentityEditSpec,
	getEditSpecOutputDuration,
	subtractRanges,
} from "@/lib/video-edits";

function isReliableGapBoundary(word: EditTranscriptWord) {
	return (
		word.endMs - word.startMs > 1 &&
		(word.confidence === null || word.confidence >= 0.8)
	);
}

function planTranscriptGaps(words: readonly EditTranscriptWord[]) {
	const ranges: SilenceRange[] = [];
	let previousMaxEnd = 0;
	for (let index = 1; index < words.length; index++) {
		const previous = words[index - 1];
		const current = words[index];
		if (!previous || !current) continue;
		previousMaxEnd = Math.max(previousMaxEnd, previous.endMs);
		if (
			isReliableGapBoundary(previous) &&
			isReliableGapBoundary(current) &&
			previousMaxEnd <= previous.endMs &&
			current.startMs - previous.endMs >= 800
		) {
			ranges.push({
				startMs: previous.endMs + 150,
				endMs: current.startMs - 150,
			});
		}
	}
	return ranges;
}

export function planAutomaticCleanup(
	transcript: EditTranscript,
	silence: readonly SilenceRange[],
) {
	if (transcript.words.length === 0)
		throw new Error("Automatic cleanup requires recognized speech");
	const previousSpec = createIdentityEditSpec(transcript.durationMs / 1000);
	const words = transcript.words.map((word) => ({
		...word,
		confidence:
			(word.confidence === null || word.confidence >= 0.8) &&
			/^(?:u+m+|u+h+|e+rm+|er)[.,!?]*$/i.test(word.text.trim())
				? word.confidence
				: 0,
	}));
	const fillers = planFillerCuts(words, transcript.durationMs, "word-gap");
	const protectedWords = transcript.words.map((word) => ({
		startMs: Math.max(0, word.startMs - (word.confidence === 0 ? 350 : 0)),
		endMs: Math.min(
			transcript.durationMs,
			Math.max(word.startMs + 1, word.endMs) +
				(word.confidence === 0 ? 350 : 0),
		),
	}));
	const plannedSilence = planSilenceCuts({
		candidates: [...silence, ...planTranscriptGaps(transcript.words)],
		words: protectedWords,
		keepRanges: previousSpec.keepRanges,
		durationMs: transcript.durationMs,
	});
	if (plannedSilence.error) throw new Error(plannedSilence.error);
	const cuts = [...fillers.ranges, ...plannedSilence.ranges].map((range) => ({
		start: range.startMs / 1000,
		end: range.endMs / 1000,
	}));
	const editSpec: VideoEditSpec = {
		...previousSpec,
		keepRanges: cuts.length
			? subtractRanges(
					previousSpec.keepRanges,
					cuts,
					previousSpec.sourceDuration,
				)
			: previousSpec.keepRanges,
	};
	if (getEditSpecOutputDuration(editSpec) < 0.5)
		throw new Error("Automatic cleanup would remove too much video");
	return {
		editSpec,
		fillerCount: fillers.fillerCount - fillers.skippedCount,
		silenceCount: plannedSilence.ranges.length,
	};
}
