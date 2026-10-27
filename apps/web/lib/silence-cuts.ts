import type { VideoEditRange } from "@cap/database/types";
import type { EditTranscriptWord } from "@/lib/edit-transcript";

export type SilenceRange = { startMs: number; endMs: number };

const HANDLE_MS = 150;
const MIN_QUIET_MS = 800;
const MIN_PLAYABLE_MS = 50;

function validRange(range: SilenceRange, durationMs: number) {
	return (
		Number.isFinite(range.startMs) &&
		Number.isFinite(range.endMs) &&
		range.startMs >= 0 &&
		range.endMs > range.startMs &&
		range.endMs <= durationMs
	);
}

function mergeRanges(ranges: readonly SilenceRange[]) {
	const merged: SilenceRange[] = [];
	for (const range of [...ranges].sort((a, b) => a.startMs - b.startMs)) {
		const previous = merged.at(-1);
		if (previous && previous.endMs >= range.startMs) {
			previous.endMs = Math.max(previous.endMs, range.endMs);
		} else {
			merged.push({ ...range });
		}
	}
	return merged;
}

export function detectPcmSilence(
	channels: readonly Float32Array[],
	sampleRate: number,
): SilenceRange[] {
	const sampleCount = channels[0]?.length ?? 0;
	if (
		!Number.isFinite(sampleRate) ||
		sampleRate < 1000 ||
		sampleCount === 0 ||
		channels.some((channel) => channel.length !== sampleCount)
	) {
		throw new Error("Audio samples are incomplete.");
	}
	const windowSize = Math.max(1, Math.round(sampleRate * 0.02));
	const ranges: SilenceRange[] = [];
	let quietStart: number | null = null;
	for (let start = 0; start < sampleCount; start += windowSize) {
		const end = Math.min(start + windowSize, sampleCount);
		let quiet = true;
		for (const channel of channels) {
			let sumSquares = 0;
			let peak = 0;
			for (let index = start; index < end; index++) {
				const value = channel[index];
				if (value === undefined || !Number.isFinite(value)) {
					throw new Error("Audio samples are invalid.");
				}
				sumSquares += value * value;
				peak = Math.max(peak, Math.abs(value));
			}
			if (Math.sqrt(sumSquares / (end - start)) > 0.001 || peak > 0.003) {
				quiet = false;
			}
		}
		if (quiet && quietStart === null) quietStart = start;
		if ((!quiet || end === sampleCount) && quietStart !== null) {
			const quietEnd = quiet ? end : start;
			if (((quietEnd - quietStart) / sampleRate) * 1000 >= MIN_QUIET_MS) {
				ranges.push({
					startMs: Math.ceil((quietStart / sampleRate) * 1000) + HANDLE_MS,
					endMs: Math.floor((quietEnd / sampleRate) * 1000) - HANDLE_MS,
				});
			}
			quietStart = null;
		}
	}
	return ranges;
}

export function planSilenceCuts({
	candidates,
	words,
	keepRanges,
	durationMs,
}: {
	candidates: readonly SilenceRange[];
	words: readonly Pick<EditTranscriptWord, "startMs" | "endMs">[];
	keepRanges: readonly VideoEditRange[];
	durationMs: number;
}): { ranges: SilenceRange[]; error: string | null } {
	const kept = keepRanges.map((range) => ({
		startMs: range.start * 1000,
		endMs: range.end * 1000,
	}));
	if (
		!Number.isFinite(durationMs) ||
		durationMs <= 0 ||
		[...candidates, ...words, ...kept].some(
			(range) => !validRange(range, durationMs),
		)
	) {
		return { ranges: [], error: "Audio or transcript timing is invalid." };
	}
	const normalizedKeeps = mergeRanges(kept);
	const safeCandidates = mergeRanges(candidates).filter(
		(range) =>
			!words.some(
				(word) =>
					word.startMs - HANDLE_MS < range.endMs &&
					word.endMs + HANDLE_MS > range.startMs,
			),
	);
	const ranges = normalizedKeeps.flatMap((keep) =>
		safeCandidates.flatMap((range) => {
			const startMs = Math.max(range.startMs, keep.startMs);
			const endMs = Math.min(range.endMs, keep.endMs);
			return endMs - startMs >= MIN_PLAYABLE_MS ? [{ startMs, endMs }] : [];
		}),
	);
	let playableMs = 0;
	for (const keep of normalizedKeeps) {
		let cursor = keep.startMs;
		for (const range of ranges) {
			if (range.endMs <= keep.startMs || range.startMs >= keep.endMs) continue;
			const remaining = range.startMs - cursor;
			if (remaining > 0 && remaining < MIN_PLAYABLE_MS) {
				return {
					ranges: [],
					error: "These cuts would leave an unplayable video fragment.",
				};
			}
			if (remaining >= MIN_PLAYABLE_MS) playableMs += remaining;
			cursor = range.endMs;
		}
		if (keep.endMs - cursor > 0 && keep.endMs - cursor < MIN_PLAYABLE_MS) {
			return {
				ranges: [],
				error: "These cuts would leave an unplayable video fragment.",
			};
		}
		if (keep.endMs - cursor >= MIN_PLAYABLE_MS) {
			playableMs += keep.endMs - cursor;
		}
	}
	if (ranges.length > 0 && playableMs < MIN_PLAYABLE_MS) {
		return { ranges: [], error: "An edit must keep some playable video." };
	}
	return { ranges, error: null };
}
