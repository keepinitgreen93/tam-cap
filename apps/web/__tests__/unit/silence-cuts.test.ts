import { describe, expect, it } from "vitest";
import { detectPcmSilence, planSilenceCuts } from "@/lib/silence-cuts";
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
	it("excludes overlapping speech and boundary handles", () => {
		expect(
			planSilenceCuts({
				...defaults,
				candidates: [{ startMs: 1000, endMs: 2000 }],
				words: [
					{ startMs: 1900, endMs: 2500 },
					{ startMs: 1800, endMs: 2300 },
				],
			}).ranges,
		).toEqual([]);
		expect(
			planSilenceCuts({
				...defaults,
				candidates: [{ startMs: 1000, endMs: 2000 }],
				words: [{ startMs: 2050, endMs: 2500 }],
			}).ranges,
		).toEqual([]);
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
