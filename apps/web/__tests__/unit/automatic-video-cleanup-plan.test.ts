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
			{ start: 2.45, end: 2.6 },
			{ start: 3.8, end: 4.65 },
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
	it("does not cut transcript gaps without measured audio silence", () => {
		const plan = planAutomaticCleanup(
			transcript([word("one", 1000, 1500), word("two", 8000, 9000)]),
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
