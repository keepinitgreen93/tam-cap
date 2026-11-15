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

	it("reports the title first, as soon as the transcript is finished", () => {
		expect(
			getRecordingPipelineStage(
				{ transcriptionStatus: "COMPLETE", metadata: {}, updatedAt: ago(0.1) },
				now,
			),
		).toBe("titling");
		for (const aiGenerationStatus of ["QUEUED", "PROCESSING"] as const)
			expect(
				getRecordingPipelineStage(
					{
						transcriptionStatus: "COMPLETE",
						metadata: {
							aiGenerationStatus,
							aiGenerationRun: { requestedAt: isoAgo(0.1) },
							transcriptionRun: { requestedAt: isoAgo(2) },
						} as never,
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
						automaticCleanup: cleanup("processing"),
						aiGenerationStatus: "PROCESSING",
						aiGenerationRun: { requestedAt: isoAgo(0.1) },
					} as never,
					updatedAt: ago(0.1),
				},
				now,
			),
		).toBe("titling");
	});

	it("reports cleanup once the title is stored until the cut is published", () => {
		const titled = {
			aiGenerationStatus: "COMPLETE",
			aiTitle: "Rebuilding My Website with AI",
			summary: "A walkthrough.",
			chapters: [{ title: "Intro", start: 0 }],
			transcriptionRun: { requestedAt: isoAgo(2) },
			transcriptPublication: { edit: true },
		};
		expect(
			getRecordingPipelineStage(
				{
					transcriptionStatus: "COMPLETE",
					metadata: titled as never,
					updatedAt: ago(0.1),
				},
				now,
			),
		).toBe("cleaning");
		expect(
			getRecordingPipelineStage(
				{
					transcriptionStatus: "COMPLETE",
					metadata: {
						...titled,
						automaticCleanup: cleanup("processing"),
					} as never,
					updatedAt: ago(1),
				},
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

	it("does not mark an already titled older recording as processing", () => {
		const titled = {
			aiGenerationStatus: "COMPLETE",
			aiTitle: "Team Recording Test",
			summary: "A test.",
			chapters: [],
		};
		expect(
			getRecordingPipelineStage(
				{
					transcriptionStatus: "COMPLETE",
					metadata: titled as never,
					updatedAt: ago(0),
				},
				now,
			),
		).toBeNull();
		expect(
			getRecordingPipelineStage(
				{
					transcriptionStatus: "COMPLETE",
					metadata: {
						...titled,
						transcriptionRun: { requestedAt: isoAgo(2) },
						transcriptPublication: { edit: true },
						completedVideoEdit: {
							token: "manual",
							startedAt: isoAgo(1),
							transcriptRemapped: true,
						},
					} as never,
					updatedAt: ago(0),
				},
				now,
			),
		).toBeNull();
	});

	it("reports title generation after cleanup only when none was kept", () => {
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
					transcriptionStatus: "COMPLETE",
					metadata: {
						aiGenerationStatus: "COMPLETE",
						aiTitle: "Rebuilding My Website with AI",
						transcriptionRun: { requestedAt: isoAgo(12) },
						transcriptPublication: { edit: true },
					} as never,
					updatedAt: ago(11),
				},
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
