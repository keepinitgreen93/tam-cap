import { describe, expect, it } from "vitest";
import { planAutomaticCleanup } from "@/lib/automatic-video-cleanup-plan";
import type { EditTranscript, EditTranscriptWord } from "@/lib/edit-transcript";

const word = (
	text: string,
	startMs: number,
	endMs: number,
	confidence: number | null = 0.95,
): EditTranscriptWord => ({
	id: `${text}-${startMs}`,
	text,
	startMs,
	endMs,
	confidence,
	speaker: null,
	channel: null,
});
const transcript = (words: EditTranscriptWord[]): EditTranscript => ({
	version: 3,
	speechModelUsed: "test",
	durationMs: 10000,
	languageCode: "en",
	words,
});

describe("automatic cleanup planning", () => {
	it("combines safe fillers and measured empty spaces while preserving speech handles", () => {
		const plan = planAutomaticCleanup(
			transcript([
				word("Hello", 1000, 1500),
				word("um", 2000, 2300),
				word("world", 4000, 4500),
			]),
			[
				{ startMs: 150, endMs: 850 },
				{ startMs: 2600, endMs: 3800 },
				{ startMs: 4650, endMs: 9850 },
			],
		);
		expect(plan.fillerCount).toBe(1);
		expect(plan.editSpec.keepRanges).toEqual([
			{ start: 0, end: 0.15 },
			{ start: 0.85, end: 1.85 },
			{ start: 3.85, end: 4.65 },
			{ start: 9.85, end: 10 },
		]);
	});
	it("keeps low confidence fillers and protects uncertain timing markers", () => {
		const plan = planAutomaticCleanup(
			transcript([word("um", 1000, 1500, 0.4), word("missed", 3000, 3000, 0)]),
			[{ startMs: 2000, endMs: 4000 }],
		);
		expect(plan.fillerCount).toBe(0);
		expect(
			plan.editSpec.keepRanges.some(
				(range) => range.start <= 3 && range.end >= 3,
			),
		).toBe(true);
	});
	it("shortens long gaps between reliable words with 150ms handles", () => {
		const plan = planAutomaticCleanup(
			transcript([word("one", 1000, 1500), word("two", 8000, 9000)]),
			[],
		);
		expect(plan.editSpec.keepRanges).toEqual([
			{ start: 0, end: 1.65 },
			{ start: 7.85, end: 10 },
		]);
	});
	it("keeps pauses shorter than 800ms", () => {
		const plan = planAutomaticCleanup(
			transcript([word("one", 1000, 1500), word("two", 2160, 2500)]),
			[],
		);
		expect(plan.editSpec.keepRanges).toEqual([{ start: 0, end: 10 }]);
	});
	it("accepts timed words without provider confidence and merges overlapping measured cuts", () => {
		const plan = planAutomaticCleanup(
			transcript([
				word("you.", 1000, 1500, null),
				word("So", 2440, 3000, null),
			]),
			[{ startMs: 1750, endMs: 2100 }],
		);
		expect(plan.editSpec.keepRanges).toEqual([
			{ start: 0, end: 1.65 },
			{ start: 2.29, end: 10 },
		]);
		expect(plan.silenceCount).toBe(1);
	});
	it.each([0, 0.4])(
		"keeps gaps adjacent to confidence %s words",
		(confidence) => {
			const plan = planAutomaticCleanup(
				transcript([
					word("one", 1000, 1500),
					word("maybe", 3000, 3300, confidence),
					word("two", 5000, 6000),
				]),
				[],
			);
			expect(plan.editSpec.keepRanges).toEqual([{ start: 0, end: 10 }]);
		},
	);
	it("keeps gaps adjacent to point or one-millisecond markers", () => {
		for (const endMs of [3000, 3001]) {
			const plan = planAutomaticCleanup(
				transcript([
					word("one", 1000, 1500),
					word("maybe", 3000, endMs, null),
					word("two", 5000, 6000),
				]),
				[],
			);
			expect(plan.editSpec.keepRanges).toEqual([{ start: 0, end: 10 }]);
		}
	});
	it("never cuts a gap covered by an earlier overlapping speech interval", () => {
		const plan = planAutomaticCleanup(
			transcript([
				word("overlapping", 1000, 5000),
				word("one", 2000, 2200),
				word("two", 4000, 4500),
			]),
			[],
		);
		expect(plan.editSpec.keepRanges).toEqual([{ start: 0, end: 10 }]);
	});
	it("does not bridge an uncertain marker inside an apparent gap", () => {
		const plan = planAutomaticCleanup(
			transcript([
				word("one", 1000, 1500),
				word("uncertain", 2500, 2501, 0),
				word("two", 4000, 4500),
			]),
			[],
		);
		expect(plan.editSpec.keepRanges).toEqual([{ start: 0, end: 10 }]);
	});
	it("refuses destructive cleanup with no recognized speech", () => {
		expect(() =>
			planAutomaticCleanup(transcript([]), [{ startMs: 150, endMs: 9850 }]),
		).toThrow();
	});
});
