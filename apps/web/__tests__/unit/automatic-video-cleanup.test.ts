import { Effect, Option } from "effect";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
	video: {} as Record<string, unknown>,
	edit: null as unknown,
	source: {} as Record<string, unknown>,
	start: vi.fn(),
	claim: vi.fn(),
	copy: vi.fn(),
	clear: vi.fn(),
	analyze: vi.fn(),
	artifacts: vi.fn(),
}));
vi.mock("server-only", () => ({}));
vi.mock("@cap/database/cloudflare/schema", () => ({
	videos: { id: "id" },
	videoEdits: { videoId: "edit" },
	videoUploads: { videoId: "upload" },
}));
vi.mock("@cap/database/cloudflare/application", () => ({
	db: () => ({
		select: () => ({
			from: (table: { videoId?: string }) => ({
				where: async () =>
					table.videoId === "edit"
						? mocks.edit
							? [mocks.edit]
							: []
						: table.videoId === "upload"
							? []
							: [mocks.video],
			}),
		}),
	}),
}));
vi.mock("@cap/database/cloudflare/transcript-publication", () => ({
	readTranscriptArtifacts: mocks.artifacts,
}));
vi.mock("@cap/web-backend/src/Videos/persistence", () => ({
	writableVideo: {},
}));
vi.mock("workflow/api", () => ({ start: mocks.start }));
vi.mock("@/workflows/automatic-video-cleanup", () => ({
	automaticVideoCleanupWorkflow: vi.fn(),
}));
vi.mock("@/lib/analyze-video-silence", () => ({
	analyzeVideoSilence: mocks.analyze,
}));
vi.mock("@/lib/silence-analysis-storage", () => ({
	loadSilenceSource: async () => ({ ...mocks.source, video: mocks.video }),
	readSilenceResult: async () => null,
}));
vi.mock("@/lib/video-edit-start", () => ({
	ensureOriginalSourceCopy: mocks.copy,
	markEditProcessing: mocks.claim,
	getCompletedProcessingReceipt: () => undefined,
}));
vi.mock("@/lib/video-edit-operation", () => ({
	clearPendingEdit: mocks.clear,
	getEditProcessingState: (metadata: { editProcessing?: unknown }) =>
		metadata.editProcessing,
}));
vi.mock("@/lib/workflow-runtime", () => ({
	runWorkflowPromise: Effect.runPromise,
}));

import {
	prepareAutomaticVideoCleanup,
	queueAutomaticVideoCleanup,
} from "@/lib/automatic-video-cleanup";

const request = {
	videoId: "video-1",
	ownerId: "owner-1",
	requestId: "79f9875f-c3a7-4879-a1a4-8a2f46da951f",
	aiGenerationEnabled: true,
};
const editSpec = {
	version: 1,
	sourceDuration: 10,
	keepRanges: [{ start: 0, end: 4 }],
};

beforeEach(() => {
	vi.stubEnv("CAP_RUNTIME", "cloudflare");
	vi.stubEnv("DATABASE_PROVIDER", "d1");
	mocks.video = {
		id: "video-1",
		ownerId: "owner-1",
		duration: 10,
		transcriptionStatus: "COMPLETE",
		source: { type: "desktopMP4" },
		metadata: { transcriptPublication: { id: "transcript-1", edit: true } },
	};
	mocks.source = {
		revision: "revision-1",
		durationMs: 10000,
		resultKey: "silence.json",
		bucket: {
			getObject: () => Effect.succeed(Option.none()),
			putObject: () => Effect.succeed(undefined),
		},
	};
	mocks.edit = null;
	mocks.artifacts.mockResolvedValue({
		editTranscript: JSON.stringify({
			version: 3,
			speechModelUsed: "whisper",
			durationMs: 10000,
			languageCode: "en",
			words: [
				{
					id: "word-1",
					text: "Hello",
					startMs: 1000,
					endMs: 2000,
					confidence: null,
					speaker: null,
					channel: null,
				},
			],
		}),
	});
	mocks.analyze.mockResolvedValue({ ranges: [{ startMs: 2150, endMs: 9850 }] });
	mocks.claim.mockResolvedValue({
		token: request.requestId,
		startedAt: "2026-11-10T00:00:00.000Z",
	});
});

describe("automatic cleanup service", () => {
	it("runs without a browser session after a completed transcript", async () => {
		expect(
			await queueAutomaticVideoCleanup(request.videoId, request.ownerId),
		).toEqual({ queued: true });
		expect(mocks.start).toHaveBeenCalledOnce();
	});
	it("does not run on hosted or non Cloudflare deployments", async () => {
		vi.stubEnv("CAP_RUNTIME", "hosted");
		expect(await prepareAutomaticVideoCleanup(request)).toBeNull();
		expect(mocks.analyze).not.toHaveBeenCalled();
	});
	it("does not touch transferred videos or existing manual edits", async () => {
		mocks.video.ownerId = "another-owner";
		expect(await prepareAutomaticVideoCleanup(request)).toBeNull();
		mocks.video.ownerId = request.ownerId;
		mocks.edit = { editSpec };
		expect(await prepareAutomaticVideoCleanup(request)).toBeNull();
		expect(mocks.claim).not.toHaveBeenCalled();
	});
	it("preserves the original before dispatching the fenced measured cleanup", async () => {
		const payload = await prepareAutomaticVideoCleanup(request);
		expect(payload?.operation.token).toBe(request.requestId);
		expect(mocks.claim).toHaveBeenCalledWith(
			expect.objectContaining({
				automaticCleanup: expect.objectContaining({
					status: "processing",
					requestId: request.requestId,
				}),
			}),
		);
		expect(mocks.copy).toHaveBeenCalledOnce();
		expect(payload?.editSpec.keepRanges).toEqual([
			{ start: 0, end: 2.15 },
			{ start: 9.85, end: 10 },
		]);
	});
	it("recovers the same operation after a step crashes following its claim", async () => {
		const operation = {
			token: request.requestId,
			startedAt: "2026-11-10T00:00:00.000Z",
		};
		mocks.video.metadata = {
			automaticCleanup: {
				version: 1,
				requestId: request.requestId,
				status: "processing",
				operation,
				sourceKey: "source.mp4",
				editSpec,
			},
			editProcessing: operation,
		};
		const payload = await prepareAutomaticVideoCleanup(request);
		expect(payload?.operation).toEqual(operation);
		expect(mocks.copy).toHaveBeenCalledOnce();
		expect(mocks.claim).not.toHaveBeenCalled();
		expect(mocks.analyze).not.toHaveBeenCalled();
	});
	it("never reapplies after completion or restore, or from a duplicate workflow", async () => {
		mocks.video.metadata = {
			automaticCleanup: { requestId: request.requestId, status: "complete" },
		};
		expect(await prepareAutomaticVideoCleanup(request)).toBeNull();
		mocks.video.metadata = { completedVideoEdit: { token: "manual-restore" } };
		expect(await prepareAutomaticVideoCleanup(request)).toBeNull();
		mocks.video.metadata = {
			automaticCleanup: { requestId: "competing-run", status: "processing" },
		};
		expect(await prepareAutomaticVideoCleanup(request)).toBeNull();
		expect(mocks.claim).not.toHaveBeenCalled();
	});
});
