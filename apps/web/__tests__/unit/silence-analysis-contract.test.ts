import { describe, expect, it } from "vitest";
import {
	readSilenceClaim,
	silenceAnalysisSchema,
	silenceClaimIsActive,
} from "@/lib/silence-analysis-contract";

const claim = {
	revision: "a".repeat(64),
	requestId: "67e55044-10b1-426f-9247-bb680e5fe0c8",
	requestedAt: 1000,
	runId: "run-1",
	status: "processing" as const,
};

describe("silence analysis contract", () => {
	it("recovers abandoned startup claims while keeping running jobs deduplicated", () => {
		expect(silenceClaimIsActive({ ...claim, runId: null }, 60_000)).toBe(true);
		expect(silenceClaimIsActive({ ...claim, runId: null }, 62_000)).toBe(false);
		expect(silenceClaimIsActive(claim, 62_000)).toBe(true);
		expect(silenceClaimIsActive(claim, 7 * 60 * 60 * 1000)).toBe(false);
		expect(silenceClaimIsActive({ ...claim, status: "error" }, 2000)).toBe(
			false,
		);
	});
	it("does not accept malformed claims", () => {
		expect(readSilenceClaim({ silenceAnalysis: claim })).toEqual(claim);
		expect(
			readSilenceClaim({
				silenceAnalysis: { ...claim, revision: "../../private" },
			}),
		).toBeNull();
		expect(readSilenceClaim(null)).toBeNull();
	});
	it.each([
		{ ranges: [{ startMs: 100, endMs: 50 }] },
		{ ranges: [{ startMs: 0, endMs: 1100 }] },
		{ ranges: [{ startMs: NaN, endMs: 500 }] },
		{
			ranges: [
				{ startMs: 0, endMs: 600 },
				{ startMs: 500, endMs: 800 },
			],
		},
	])("rejects invalid analysis range sets", ({ ranges }) => {
		expect(
			silenceAnalysisSchema.safeParse({
				version: 1,
				profile: "pcm-quiet-v1",
				durationMs: 1000,
				audioTracks: 1,
				ranges,
			}).success,
		).toBe(false);
	});
	it("rejects absent audio and unknown detector profiles", () => {
		expect(
			silenceAnalysisSchema.safeParse({
				version: 1,
				profile: "pcm-quiet-v1",
				durationMs: 1000,
				audioTracks: 0,
				ranges: [],
			}).success,
		).toBe(false);
		expect(
			silenceAnalysisSchema.safeParse({
				version: 1,
				profile: "transcript-gaps",
				durationMs: 1000,
				audioTracks: 1,
				ranges: [],
			}).success,
		).toBe(false);
	});
});
