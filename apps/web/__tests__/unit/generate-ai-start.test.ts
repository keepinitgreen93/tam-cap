import { beforeEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({
	claim: vi.fn(),
	update: vi.fn(),
	start: vi.fn(),
	queue: vi.fn(),
	getRun: vi.fn(),
	configured: vi.fn(),
}));
vi.mock("@cap/database/cloudflare/application", () => ({ db: () => ({}) }));
vi.mock("@cap/database/cloudflare/ai-generation", () => ({
	claimAiGeneration: state.claim,
	updateAiGenerationRun: state.update,
}));
vi.mock("@/lib/ai/provider", () => ({ isAiConfigured: state.configured }));
vi.mock("workflow/api", () => ({ start: state.start, getRun: state.getRun }));
vi.mock("workflow/runtime", () => ({
	getWorld: () => ({ queue: state.queue }),
}));
vi.mock("@/workflows/generate-ai", () => ({ generateAiWorkflow: vi.fn() }));

import { startAiGeneration } from "@/lib/generate-ai";

const run = {
	id: "synthetic-run",
	dispatch: "pending",
	mediaRevision: "revision",
	transcriptId: "transcript",
};

beforeEach(() => {
	vi.clearAllMocks();
	state.configured.mockReturnValue(true);
	state.claim.mockResolvedValue({ state: "claimed", run });
	state.update.mockResolvedValue(true);
	state.queue.mockResolvedValue(undefined);
	state.start.mockImplementation(async (_workflow, _payload, options) => {
		await options.world.queue(
			"workflow-queue",
			{ runId: "workflow-1" },
			{ deploymentId: "deployment-1" },
		);
		return { runId: "workflow-1" };
	});
});

describe("startAiGeneration", () => {
	it("fails fast without a configured provider", async () => {
		state.configured.mockReturnValue(false);
		expect(await startAiGeneration("video-1" as never, "user-1")).toEqual({
			success: false,
			message: "No AI provider configured",
		});
		expect(state.claim).not.toHaveBeenCalled();
	});
	it("records the durable workflow identity before delivering the queue message", async () => {
		state.queue.mockImplementationOnce(async () => {
			expect(state.update).toHaveBeenCalledWith({}, "video-1", run.id, {
				run: {
					workflowRunId: "workflow-1",
					workflowQueue: "workflow-queue",
					deploymentId: "deployment-1",
				},
			});
		});
		expect(await startAiGeneration("video-1" as never, "user-1")).toEqual({
			success: true,
			message: "AI generation workflow started",
		});
		expect(state.start.mock.calls[0]?.[1]).toEqual([
			{ videoId: "video-1", userId: "user-1", runId: run.id },
		]);
	});
	it("does not dispatch a duplicate claim", async () => {
		state.claim.mockResolvedValue({ state: "in-progress", run });
		expect(
			(await startAiGeneration("video-1" as never, "user-1")).success,
		).toBe(true);
		expect(state.start).not.toHaveBeenCalled();
	});
	it("records pre-queue rejection as an error for that run only", async () => {
		state.start.mockRejectedValueOnce(new Error("serialization rejected"));
		expect(
			(await startAiGeneration("video-1" as never, "user-1")).success,
		).toBe(false);
		expect(state.update).toHaveBeenCalledWith({}, "video-1", run.id, {
			status: "ERROR",
			run: { dispatch: "rejected" },
		});
	});
	it("retains a dispatch whose queue acknowledgement was lost", async () => {
		state.queue.mockRejectedValueOnce(new Error("acknowledgement lost"));
		expect(
			(await startAiGeneration("video-1" as never, "user-1")).success,
		).toBe(false);
		expect(state.update).toHaveBeenLastCalledWith({}, "video-1", run.id, {
			run: { dispatch: "uncertain" },
		});
	});
	it("replays a pending durable run without creating a replacement", async () => {
		state.claim.mockResolvedValue({
			state: "in-progress",
			run: {
				...run,
				workflowRunId: "workflow-1",
				workflowQueue: "workflow-queue",
			},
		});
		state.getRun.mockReturnValue({
			exists: Promise.resolve(true),
			status: Promise.resolve("pending"),
		});
		await startAiGeneration("video-1" as never, "user-1");
		expect(state.queue).toHaveBeenCalledWith(
			"workflow-queue",
			{ runId: "workflow-1" },
			{ deploymentId: undefined },
		);
		expect(state.start).not.toHaveBeenCalled();
	});
	it("does not turn a resume readback failure into an error on a possibly active run", async () => {
		state.claim.mockResolvedValue({
			state: "in-progress",
			run: {
				...run,
				workflowRunId: "workflow-1",
				workflowQueue: "workflow-queue",
			},
		});
		state.getRun.mockReturnValue({
			exists: Promise.reject(new Error("readback unavailable")),
		});
		expect(
			(await startAiGeneration("video-1" as never, "user-1")).success,
		).toBe(false);
		expect(state.update).not.toHaveBeenCalled();
	});
	it("allows an explicitly terminated durable workflow to be retried", async () => {
		state.claim.mockResolvedValue({
			state: "in-progress",
			run: {
				...run,
				workflowRunId: "workflow-1",
				workflowQueue: "workflow-queue",
			},
		});
		state.getRun.mockReturnValue({
			exists: Promise.resolve(true),
			status: Promise.resolve("failed"),
		});
		expect(
			(await startAiGeneration("video-1" as never, "user-1")).success,
		).toBe(false);
		expect(state.update).toHaveBeenCalledWith({}, "video-1", run.id, {
			status: "ERROR",
		});
		expect(state.start).not.toHaveBeenCalled();
	});
});
