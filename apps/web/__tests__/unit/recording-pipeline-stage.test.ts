import { describe, expect, it } from "vitest";
import {
	getRecordingPipelineLabel,
	getRecordingPipelineStage,
} from "@/lib/recording-pipeline-stage";

const now = Date.parse("2026-11-15T02:45:00.000Z");
const ago = (minutes: number) => new Date(now - minutes * 60_000);
const isoAgo = (minutes: number) => ago(minutes).toISOString();
const cleanup = (status: "processing" | "complete" | "skipped" | "error") => ({
	version: 1 as const,
	requestId: "request",
	transcriptId: "transcript",
	status,
	operation: { token: "request", startedAt: isoAgo(1) },
	sourceKey: "owner/video/original.mp4",
	editSpec: { version: 1 as const, sourceDuration: 10, keepRanges: [] },
	fillerCount: 0,
	silenceCount: 0,
});

describe("getRecordingPipelineStage", () => {
	it("reports finalization while a desktop recording is being assembled", () => {
		for (const finalizationState of [
			"committing",
			"queued",
			"processing",
			"retry",
		])
			expect(
				getRecordingPipelineStage(
					{
						transcriptionStatus: null,
						finalizationState,
						finalizationUpdatedAt: ago(1),
					},
					now,
				),
			).toBe("finalizing");
	});

	it("reports transcription between verified finalization and the transcript", () => {
		expect(
			getRecordingPipelineStage(
				{
					transcriptionStatus: null,
					finalizationState: "verified",
					finalizationUpdatedAt: ago(1),
				},
				now,
			),
		).toBe("transcribing");
		expect(
			getRecordingPipelineStage(
				{
					transcriptionStatus: "PROCESSING",
					metadata: {
						transcriptionRun: { requestedAt: isoAgo(2) },
					} as never,
					updatedAt: ago(2),
				},
				now,
			),
		).toBe("transcribing");
	});

	it("reports cleanup after the transcript until the edit finishes", () => {
		expect(
			getRecordingPipelineStage(
				{ transcriptionStatus: "COMPLETE", metadata: {}, updatedAt: ago(1) },
				now,
			),
		).toBe("cleaning");
		expect(
			getRecordingPipelineStage(
				{
					transcriptionStatus: "COMPLETE",
					metadata: { automaticCleanup: cleanup("processing") } as never,
					updatedAt: ago(1),
				},
				now,
			),
		).toBe("cleaning");
	});

	it("reports title generation after cleanup until AI output exists", () => {
		for (const status of ["complete", "skipped"] as const)
			expect(
				getRecordingPipelineStage(
					{
						transcriptionStatus: "COMPLETE",
						metadata: { automaticCleanup: cleanup(status) } as never,
						updatedAt: ago(0.1),
					},
					now,
				),
			).toBe("titling");
		expect(
			getRecordingPipelineStage(
				{
					transcriptionStatus: "COMPLETE",
					metadata: {
						automaticCleanup: cleanup("complete"),
						aiGenerationStatus: "PROCESSING",
						aiGenerationRun: { requestedAt: isoAgo(0.1) },
					} as never,
					updatedAt: ago(0.1),
				},
				now,
			),
		).toBe("titling");
	});

	it("is settled once the title and summary are stored", () => {
		expect(
			getRecordingPipelineStage(
				{
					transcriptionStatus: "COMPLETE",
					metadata: {
						automaticCleanup: cleanup("complete"),
						aiGenerationStatus: "COMPLETE",
						aiTitle: "Rebuilding My Website with AI",
					} as never,
					updatedAt: ago(0),
				},
				now,
			),
		).toBeNull();
	});

	it("is settled for terminal transcription states and screenshots", () => {
		for (const transcriptionStatus of ["ERROR", "SKIPPED", "NO_AUDIO"])
			expect(
				getRecordingPipelineStage(
					{ transcriptionStatus, metadata: {}, updatedAt: ago(0) },
					now,
				),
			).toBeNull();
		expect(
			getRecordingPipelineStage(
				{
					isScreenshot: true,
					transcriptionStatus: "PROCESSING",
					updatedAt: ago(0),
				},
				now,
			),
		).toBeNull();
		expect(
			getRecordingPipelineStage({ transcriptionStatus: null }, now),
		).toBeNull();
		expect(
			getRecordingPipelineStage(
				{
					transcriptionStatus: null,
					finalizationState: "source-blocked",
					finalizationUpdatedAt: ago(0),
				},
				now,
			),
		).toBeNull();
	});

	it("never marks a stale run as processing", () => {
		expect(
			getRecordingPipelineStage(
				{
					transcriptionStatus: "PROCESSING",
					metadata: {
						transcriptionRun: { requestedAt: isoAgo(61) },
					} as never,
					updatedAt: ago(61),
				},
				now,
			),
		).toBeNull();
		expect(
			getRecordingPipelineStage(
				{ transcriptionStatus: "COMPLETE", metadata: {}, updatedAt: ago(11) },
				now,
			),
		).toBeNull();
		expect(
			getRecordingPipelineStage(
				{
					transcriptionStatus: null,
					finalizationState: "queued",
					finalizationUpdatedAt: ago(61),
				},
				now,
			),
		).toBeNull();
		expect(
			getRecordingPipelineStage(
				{
					transcriptionStatus: "COMPLETE",
					metadata: {
						automaticCleanup: {
							...cleanup("processing"),
							operation: { token: "request", startedAt: isoAgo(61) },
						},
					} as never,
					updatedAt: ago(61),
				},
				now,
			),
		).toBeNull();
	});

	it("labels every stage as processing", () => {
		for (const stage of [
			"finalizing",
			"transcribing",
			"cleaning",
			"titling",
		] as const)
			expect(getRecordingPipelineLabel(stage)).toMatch(/^Processing: /);
	});
});
