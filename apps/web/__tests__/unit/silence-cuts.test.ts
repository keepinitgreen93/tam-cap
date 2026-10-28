import { describe, expect, it } from "vitest";
import { planFillerCuts } from "@/lib/edit-transcript";
import {
	detectPcmSilence,
	matchesSilenceTimeline,
	planSilenceCuts,
} from "@/lib/silence-cuts";
import {
	composeEditSpecs,
	createTimelineHistory,
	createTimelineState,
	deleteTimelineRanges,
	getTimelineEditSpec,
	getTimelineKeepRanges,
	pushTimelineHistory,
	redoTimelineHistory,
	undoTimelineHistory,
} from "@/lib/video-edits";

describe("silence timeline compatibility", () => {
	it("accepts the verified desktop AAC tail only for server-backed analysis", () => {
		expect(matchesSilenceTimeline(25993.042, 25943, true)).toBe(true);
		expect(matchesSilenceTimeline(25993.042, 25943, false)).toBe(false);
		expect(matchesSilenceTimeline(26044, 25943, true)).toBe(false);
	});

	it("keeps browser fallback bounded and rejects invalid durations", () => {
		expect(matchesSilenceTimeline(25993, 25943, false)).toBe(true);
		expect(matchesSilenceTimeline(NaN, 25943, true)).toBe(false);
		expect(matchesSilenceTimeline(25943, 0, true)).toBe(false);
	});
});

describe("PCM silence candidates", () => {
	it("retains handles around sustained quiet audio", () => {
		const samples = new Float32Array(3000).fill(0.1);
		samples.fill(0, 1000, 2000);
		expect(detectPcmSilence([samples], 1000)).toEqual([
			{ startMs: 1150, endMs: 1850 },
		]);
	});

	it("does not infer silence from a transcript gap, noise, or another channel", () => {
		const silence = new Float32Array(2000);
		const noise = new Float32Array(2000).fill(0.005);
		expect(detectPcmSilence([noise], 1000)).toEqual([]);
		expect(detectPcmSilence([silence, noise], 1000)).toEqual([]);
		expect(
			detectPcmSilence([noise, noise.map((value) => -value)], 1000),
		).toEqual([]);
	});

	it("preserves short pauses and isolated audible peaks", () => {
		const samples = new Float32Array(1000);
		samples[500] = 0.1;
		expect(detectPcmSilence([samples], 1000)).toEqual([]);
	});

	it("rejects corrupt, absent and mismatched PCM", () => {
		expect(() => detectPcmSilence([], 1000)).toThrow();
		expect(() => detectPcmSilence([new Float32Array(1000)], 0)).toThrow();
		expect(() => detectPcmSilence([new Float32Array([NaN])], 1000)).toThrow();
		expect(() =>
			detectPcmSilence([new Float32Array(1), new Float32Array(2)], 1000),
		).toThrow();
	});
});

const defaults = {
	durationMs: 4000,
	keepRanges: [{ start: 0, end: 4 }],
	words: [],
};

describe("silence cut planning", () => {
	it("retains measured speech-free portions of the owner recording after unsaved filler cuts", () => {
		const timings = [
			[720, 1760],
			[2240, 2880],
			[2880, 3120],
			[3120, 3360],
			[3360, 3520],
			[3520, 3920],
			[3920, 4400],
			[4400, 4800],
			[7512, 8072],
			[8072, 8312],
			[8312, 8552],
			[8552, 9112],
			[9112, 9672],
			[9672, 9832],
			[9832, 10072],
			[10072, 10312],
			[10312, 11112],
			[13592, 13832],
			[13832, 14232],
			[14232, 14632],
			[14632, 15032],
			[15032, 15352],
			[15352, 15592],
			[15592, 15992],
			[15992, 16392],
		] as const;
		const words = timings.map(([startMs, endMs], index) => ({
			id: `word-${index}`,
			text: index === 1 ? "Um" : index === 8 ? "Uh" : "speech",
			startMs,
			endMs,
			confidence: null,
			speaker: null,
			channel: null,
		}));
		const candidates = [
			{ startMs: 690, endMs: 1230 },
			{ startMs: 4070, endMs: 6610 },
			{ startMs: 10050, endMs: 12590 },
		];
		const input = {
			candidates,
			words,
			durationMs: 17133,
			keepRanges: [{ start: 0, end: 17.133 }],
		};
		const expected = [
			{ startMs: 4950, endMs: 6610 },
			{ startMs: 11262, endMs: 12590 },
		];
		expect(planSilenceCuts(input)).toEqual({ ranges: expected, error: null });
		const fillers = planFillerCuts(words, input.durationMs);
		const afterFillers = deleteTimelineRanges(
			createTimelineState(17.133),
			fillers.ranges.map((range) => ({
				start: range.startMs / 1000,
				end: range.endMs / 1000,
			})),
		);
		expect(fillers.ranges).toHaveLength(2);
		expect(
			planSilenceCuts({
				...input,
				keepRanges: getTimelineKeepRanges(afterFillers),
			}),
		).toEqual({ ranges: expected, error: null });
		expect(planSilenceCuts({ ...input, candidates: expected })).toEqual({
			ranges: expected,
			error: null,
		});
		for (const cut of expected)
			expect(
				words.some(
					(word) =>
						word.startMs - 150 < cut.endMs && word.endMs + 150 > cut.startMs,
				),
			).toBe(false);
	});
	it("splits measured quiet around protected speech without moving its boundaries", () => {
		expect(
			planSilenceCuts({
				...defaults,
				candidates: [{ startMs: 100, endMs: 3900 }],
				words: [
					{ startMs: 3500, endMs: 3950 },
					{ startMs: 1500, endMs: 2000 },
					{ startMs: 0, endMs: 300 },
				],
			}),
		).toEqual({
			ranges: [
				{ startMs: 450, endMs: 1350 },
				{ startMs: 2150, endMs: 3350 },
			],
			error: null,
		});
		expect(
			planSilenceCuts({
				...defaults,
				candidates: [{ startMs: 1000, endMs: 2000 }],
				words: [{ startMs: 900, endMs: 2100 }],
			}),
		).toEqual({ ranges: [], error: null });
	});
	it("composes current playback cuts onto the immutable original after a saved edit", () => {
		const previous = {
			version: 1 as const,
			sourceDuration: 10,
			keepRanges: [
				{ start: 0, end: 2 },
				{ start: 8, end: 10 },
			],
		};
		const plan = planSilenceCuts({
			...defaults,
			candidates: [{ startMs: 1000, endMs: 3000 }],
		});
		const next = deleteTimelineRanges(
			createTimelineState(4),
			plan.ranges.map((range) => ({
				start: range.startMs / 1000,
				end: range.endMs / 1000,
			})),
		);
		expect(composeEditSpecs(previous, getTimelineEditSpec(next))).toEqual({
			version: 1,
			sourceDuration: 10,
			keepRanges: [
				{ start: 0, end: 1 },
				{ start: 9, end: 10 },
			],
		});
		expect(previous.keepRanges).toEqual([
			{ start: 0, end: 2 },
			{ start: 8, end: 10 },
		]);
	});
	it("subtracts overlapping speech and boundary handles", () => {
		expect(
			planSilenceCuts({
				...defaults,
				candidates: [{ startMs: 1000, endMs: 2000 }],
				words: [
					{ startMs: 1900, endMs: 2500 },
					{ startMs: 1800, endMs: 2300 },
				],
			}).ranges,
		).toEqual([{ startMs: 1000, endMs: 1650 }]);
		expect(
			planSilenceCuts({
				...defaults,
				candidates: [{ startMs: 1000, endMs: 2000 }],
				words: [{ startMs: 2050, endMs: 2500 }],
			}).ranges,
		).toEqual([{ startMs: 1000, endMs: 1900 }]);
	});

	it("intersects partial previous cuts and merges overlapping candidates without double counting", () => {
		expect(
			planSilenceCuts({
				...defaults,
				candidates: [
					{ startMs: 500, endMs: 2500 },
					{ startMs: 1000, endMs: 3000 },
				],
				keepRanges: [
					{ start: 0, end: 1 },
					{ start: 2, end: 4 },
				],
			}),
		).toEqual({
			ranges: [
				{ startMs: 500, endMs: 1000 },
				{ startMs: 2000, endMs: 3000 },
			],
			error: null,
		});
	});

	it("rejects cuts that leave only unplayable fragments", () => {
		expect(
			planSilenceCuts({
				...defaults,
				candidates: [{ startMs: 20, endMs: 3980 }],
			}).error,
		).toContain("playable");
	});

	it("rejects deleting all remaining footage after earlier cuts", () => {
		expect(
			planSilenceCuts({
				...defaults,
				candidates: [{ startMs: 1000, endMs: 2000 }],
				keepRanges: [{ start: 1, end: 2 }],
			}).error,
		).toContain("playable");
	});

	it("does not discard tiny audible gaps between separately detected ranges", () => {
		expect(
			planSilenceCuts({
				...defaults,
				candidates: [
					{ startMs: 500, endMs: 1000 },
					{ startMs: 1020, endMs: 2000 },
				],
			}).error,
		).toContain("fragment");
	});

	it.each([NaN, Infinity, -1, 4001])(
		"rejects invalid candidate timestamps %s",
		(endMs) => {
			expect(
				planSilenceCuts({ ...defaults, candidates: [{ startMs: 0, endMs }] })
					.error,
			).toContain("invalid");
		},
	);

	it("rejects corrupt transcript or keep timing", () => {
		expect(
			planSilenceCuts({
				...defaults,
				candidates: [],
				words: [{ startMs: 5, endMs: 4 }],
			}).error,
		).toContain("invalid");
		expect(
			planSilenceCuts({
				...defaults,
				candidates: [],
				keepRanges: [{ start: 0, end: NaN }],
			}).error,
		).toContain("invalid");
	});

	it("applies all candidates in one undoable edit without mutating prior history", () => {
		const original = createTimelineState(4);
		const history = createTimelineHistory(original);
		const plan = planSilenceCuts({
			...defaults,
			candidates: [
				{ startMs: 500, endMs: 1000 },
				{ startMs: 2000, endMs: 3000 },
			],
		});
		const edited = deleteTimelineRanges(
			original,
			plan.ranges.map((range) => ({
				start: range.startMs / 1000,
				end: range.endMs / 1000,
			})),
		);
		const applied = pushTimelineHistory(history, edited);
		expect(applied.entries).toHaveLength(2);
		expect(getTimelineKeepRanges(edited)).toEqual([
			{ start: 0, end: 0.5 },
			{ start: 1, end: 2 },
			{ start: 3, end: 4 },
		]);
		expect(undoTimelineHistory(applied).index).toBe(0);
		expect(redoTimelineHistory(undoTimelineHistory(applied)).index).toBe(1);
		expect(original.deletedRanges).toEqual([]);
	});
});
