import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
	importerJobState: vi.fn(),
	where: vi.fn(),
	writeReceipt: vi.fn(),
	set: vi.fn(),
	queue: vi.fn(),
	start: vi.fn(),
	getRun: vi.fn(),
	getWorld: vi.fn(),
	mediaJobFailed: vi.fn(),
}));

vi.mock("@cap/database/cloudflare/application", () => ({
	db: () => ({
		update: () => ({ set: mocks.set }),
		select: () => ({
			from: () => ({ where: () => ({ limit: async () => [{}] }) }),
		}),
	}),
}));
vi.mock("@cap/database/cloudflare/schema", () => ({
	videos: { id: "videoId", ownerId: "ownerId", metadata: "metadata" },
	videoUploads: {
		videoId: "uploadVideoId",
		phase: "phase",
		updatedAt: "updatedAt",
	},
}));
vi.mock("@cap/web-domain", () => ({
	Video: { VideoId: { make: (id: string) => id } },
	User: { UserId: { make: (id: string) => id } },
}));
vi.mock("drizzle-orm", () => ({
	eq: (column: string, value: unknown) => ({ column, value }),
	and: (...conditions: unknown[]) => ({ conditions }),
	sql: (strings: TemplateStringsArray, ...values: unknown[]) => ({
		strings,
		values,
	}),
}));
vi.mock("workflow/api", () => ({ start: mocks.start, getRun: mocks.getRun }));
vi.mock("workflow/runtime", () => ({ getWorld: mocks.getWorld }));
vi.mock("@/lib/loom-media-dispatch", () => ({
	isLoomMediaJobFailed: mocks.mediaJobFailed,
	getLoomImporterJobState: mocks.importerJobState,
}));
vi.mock("@/lib/loom-import-state", () => ({
	writeLoomImportReceipt: mocks.writeReceipt,
}));
vi.mock("@/workflows/import-loom-video", () => ({
	importLoomVideoWorkflow: vi.fn(),
}));

import {
	getLoomImportRunState,
	LoomImportStartError,
	restoreLoomImportStartError,
	startLoomImportWorkflow,
} from "@/lib/loom-import-start";

const payload = {
	videoId: "video-1",
	userId: "owner-1",
	rawFileKey: "owner-1/video-1/raw-upload.mp4",
	bucketId: null,
	loomVideoId: "loom-1",
};

describe("Loom workflow startup receipts", () => {
	beforeEach(() => {
		vi.resetAllMocks();
		mocks.set.mockReturnValue({ where: mocks.where });
		mocks.where.mockResolvedValue({ meta: { changes: 1 } });
		mocks.writeReceipt.mockResolvedValue(true);
		mocks.queue.mockResolvedValue({ messageId: "message-1" });
		mocks.getWorld.mockReturnValue({ queue: mocks.queue });
		mocks.mediaJobFailed.mockResolvedValue(false);
		mocks.start.mockImplementation(
			async (
				_workflow: unknown,
				_args: unknown,
				options: {
					world: {
						queue: (
							name: string,
							message: { runId: string },
						) => Promise<unknown>;
					};
				},
			) => {
				await options.world.queue("workflow-loom", { runId: "run-1" });
			},
		);
	});

	it("treats a run that was never created as inactive", async () => {
		const { WorkflowRunNotFoundError } = await import(
			"workflow/internal/errors"
		);
		mocks.getRun.mockReturnValue({
			status: Promise.reject(new WorkflowRunNotFoundError("run-1")),
		});
		expect(
			await getLoomImportRunState({ runId: "run-1", dispatch: "uncertain" }),
		).toBe("inactive");
		mocks.getRun.mockReturnValue({
			status: Promise.reject(new Error("network")),
		});
		expect(
			await getLoomImportRunState({ runId: "run-1", dispatch: "uncertain" }),
		).toBe("unconfirmed");
	});

	it.each([
		["running", "active"],
		["finished", "inactive"],
		["missing", "inactive"],
		["unknown", "unconfirmed"],
	] as const)(
		"asks the importer about its own jobs: %s",
		async (importerState, expected) => {
			mocks.getRun.mockReturnValue({ status: Promise.resolve("failed") });
			mocks.importerJobState.mockResolvedValue(importerState);
			mocks.mediaJobFailed.mockResolvedValue(false);
			expect(
				await getLoomImportRunState({
					runId: "run-1",
					dispatch: "accepted",
					mediaDispatch: {
						attemptId: "run-1:0",
						videoId: "video-1",
						jobId: "importer-1",
						state: "accepted",
						worker: "importer",
					},
				}),
			).toBe(expected);
			expect(mocks.importerJobState).toHaveBeenCalledWith({
				jobId: "importer-1",
				videoId: "video-1",
			});
		},
	);

	it("does not trust a missing importer job for media server dispatches", async () => {
		mocks.getRun.mockReturnValue({ status: Promise.resolve("failed") });
		mocks.importerJobState.mockResolvedValue("missing");
		mocks.mediaJobFailed.mockResolvedValue(false);
		expect(
			await getLoomImportRunState({
				runId: "run-1",
				dispatch: "accepted",
				mediaDispatch: {
					attemptId: "run-1:0",
					videoId: "video-1",
					jobId: "worker-1",
					state: "accepted",
				},
			}),
		).toBe("unconfirmed");
	});

	it.each([false, true])(
		"requires a matching failed worker before releasing an accepted dispatch: %s",
		async (failed) => {
			mocks.getRun.mockReturnValue({ status: Promise.resolve("failed") });
			mocks.mediaJobFailed.mockResolvedValue(failed);
			expect(
				await getLoomImportRunState({
					runId: "run-1",
					dispatch: "accepted",
					mediaDispatch: {
						attemptId: "run-1:0",
						videoId: "video-1",
						jobId: "worker-1",
						state: "accepted",
					},
				}),
			).toBe(failed ? "inactive" : "unconfirmed");
			expect(mocks.mediaJobFailed).toHaveBeenCalledWith("worker-1", "video-1");
		},
	);

	it("records the run before dispatch and stores queue acceptance", async () => {
		await startLoomImportWorkflow(payload);
		expect(mocks.writeReceipt.mock.calls.map((call) => call[2])).toEqual([
			{ runId: "run-1", workflowQueue: "workflow-loom", dispatch: "pending" },
			{ runId: "run-1", workflowQueue: "workflow-loom", dispatch: "accepted" },
		]);
		expect(mocks.writeReceipt.mock.invocationCallOrder[0]).toBeLessThan(
			mocks.queue.mock.invocationCallOrder[0] ?? 0,
		);
	});

	it("keeps an operator import's bulk lane on its startup receipt", async () => {
		await startLoomImportWorkflow({ ...payload, importPriority: "bulk" });
		expect(mocks.writeReceipt.mock.calls.map((call) => call[2])).toEqual([
			{
				runId: "run-1",
				workflowQueue: "workflow-loom",
				dispatch: "pending",
				importPriority: "bulk",
			},
			{
				runId: "run-1",
				workflowQueue: "workflow-loom",
				dispatch: "accepted",
				importPriority: "bulk",
			},
		]);
	});

	it("does not overwrite a newer import startup receipt", async () => {
		mocks.writeReceipt.mockResolvedValueOnce(true).mockResolvedValueOnce(false);
		await expect(startLoomImportWorkflow(payload)).resolves.toBeUndefined();
		expect(mocks.writeReceipt.mock.calls[0]?.[3]).toBeNull();
		expect(mocks.writeReceipt.mock.calls.at(-1)?.[2]).toMatchObject({
			runId: "run-1",
			dispatch: "accepted",
		});
	});

	it.each([
		"BadRequestError",
		"UnauthorizedError",
		"ForbiddenError",
		"TooManyRequestsError",
	])("allows retry after an explicit queue rejection: %s", async (name) => {
		mocks.queue.mockRejectedValueOnce(
			Object.assign(new Error("Queue rejected"), { name }),
		);
		await expect(startLoomImportWorkflow(payload)).rejects.toMatchObject({
			canRetry: true,
		});
		expect(mocks.writeReceipt.mock.calls.at(-1)?.[2]).toEqual({
			runId: "run-1",
			workflowQueue: "workflow-loom",
			dispatch: "rejected",
		});
	});

	it("preserves an uncertain queue acknowledgement without allowing another dispatch", async () => {
		mocks.queue.mockRejectedValueOnce(new TypeError("Connection reset"));
		await expect(startLoomImportWorkflow(payload)).rejects.toMatchObject({
			canRetry: false,
		});
		expect(mocks.writeReceipt.mock.calls.at(-1)?.[2]).toEqual({
			runId: "run-1",
			workflowQueue: "workflow-loom",
			dispatch: "uncertain",
		});
	});

	it("does not treat a run creation error as a rejected queue message", async () => {
		mocks.start.mockImplementationOnce(
			async (
				_workflow: unknown,
				_args: unknown,
				options: {
					world: {
						queue: (
							name: string,
							message: { runId: string },
						) => Promise<unknown>;
					};
				},
			) => {
				await options.world.queue("workflow-loom", { runId: "run-1" });
				throw Object.assign(new Error("Run creation rejected"), {
					name: "BadRequestError",
				});
			},
		);
		await expect(startLoomImportWorkflow(payload)).resolves.toBeUndefined();
		expect(mocks.writeReceipt.mock.calls.at(-1)?.[2].dispatch).toBe("accepted");
	});

	it("allows retry when startup fails before dispatch", async () => {
		mocks.start.mockRejectedValueOnce(new Error("Workflow not registered"));
		await expect(startLoomImportWorkflow(payload)).rejects.toBeInstanceOf(
			LoomImportStartError,
		);
		await expect(startLoomImportWorkflow(payload)).resolves.toBeUndefined();
		expect(mocks.queue).toHaveBeenCalledTimes(1);
	});

	it("does not send a job when its run receipt cannot be saved", async () => {
		mocks.writeReceipt.mockResolvedValueOnce(false);
		await expect(startLoomImportWorkflow(payload)).rejects.toMatchObject({
			canRetry: true,
		});
		expect(mocks.queue).not.toHaveBeenCalled();
	});

	it("keeps the claim when a rejected dispatch receipt cannot be saved", async () => {
		mocks.queue.mockRejectedValueOnce(
			Object.assign(new Error("Queue rejected"), { name: "ForbiddenError" }),
		);
		mocks.writeReceipt
			.mockResolvedValueOnce(true)
			.mockRejectedValueOnce(new Error("Database unavailable"));
		await expect(startLoomImportWorkflow(payload)).rejects.toMatchObject({
			canRetry: false,
		});
	});

	it.each(["pending", "running", "completed", "failed", "cancelled"] as const)(
		"uses authoritative run status for %s",
		async (status) => {
			mocks.getRun.mockReturnValue({ status: Promise.resolve(status) });
			expect(
				await getLoomImportRunState({ runId: "run-1", dispatch: "uncertain" }),
			).toBe(
				status === "pending"
					? "pending"
					: status === "running"
						? "active"
						: "inactive",
			);
		},
	);

	it("requeues a pending durable receipt without creating a new workflow", async () => {
		mocks.getRun.mockReturnValue({
			status: Promise.resolve("pending"),
			createdAt: Promise.resolve(new Date()),
		});
		expect(
			await getLoomImportRunState({
				runId: "run-1",
				dispatch: "uncertain",
				workflowQueue: "workflow-loom",
				deploymentId: "deployment",
			}),
		).toBe("pending");
		expect(mocks.queue).toHaveBeenCalledWith(
			"workflow-loom",
			{ runId: "run-1" },
			{ deploymentId: "deployment" },
		);
		expect(mocks.start).not.toHaveBeenCalled();
	});

	it("cancels a run that never left pending and treats it as inactive", async () => {
		const run = {
			status: Promise.resolve("pending"),
			createdAt: Promise.resolve(new Date(Date.now() - 2 * 60 * 60 * 1000)),
			cancel: vi.fn(async () => {
				run.status = Promise.resolve("cancelled");
			}),
		};
		mocks.getRun.mockReturnValue(run);
		expect(
			await getLoomImportRunState({ runId: "run-1", dispatch: "uncertain" }),
		).toBe("inactive");
		expect(run.cancel).toHaveBeenCalledTimes(1);
	});

	it("leaves a recently queued run pending", async () => {
		const cancel = vi.fn();
		mocks.getRun.mockReturnValue({
			status: Promise.resolve("pending"),
			createdAt: Promise.resolve(new Date(Date.now() - 10 * 60 * 1000)),
			cancel,
		});
		expect(
			await getLoomImportRunState({ runId: "run-1", dispatch: "uncertain" }),
		).toBe("pending");
		expect(cancel).not.toHaveBeenCalled();
	});

	it("keeps an old pending run pending when it cannot be cancelled", async () => {
		mocks.getRun.mockReturnValue({
			status: Promise.resolve("pending"),
			createdAt: Promise.resolve(new Date(Date.now() - 2 * 60 * 60 * 1000)),
			cancel: vi.fn().mockRejectedValue(new Error("Unavailable")),
		});
		expect(
			await getLoomImportRunState({ runId: "run-1", dispatch: "uncertain" }),
		).toBe("pending");
	});

	it("holds startup while the run cannot be queried", async () => {
		mocks.getRun.mockReturnValue({
			status: Promise.reject(new Error("Not found yet")),
		});
		expect(
			await getLoomImportRunState({ runId: "run-1", dispatch: "uncertain" }),
		).toBe("unconfirmed");
	});

	it.each(["completed", "failed", "cancelled"])(
		"holds an uncertain media dispatch after the workflow is %s",
		async (status) => {
			mocks.getRun.mockReturnValue({ status: Promise.resolve(status) });
			expect(
				await getLoomImportRunState({
					runId: "run-1",
					dispatch: "accepted",
					mediaDispatch: { attemptId: "run-1:0", state: "uncertain" },
				}),
			).toBe("unconfirmed");
		},
	);

	it("allows rejected and legacy imports without an active run check", async () => {
		expect(
			await getLoomImportRunState({ runId: "run-1", dispatch: "rejected" }),
		).toBe("inactive");
		expect(await getLoomImportRunState()).toBe("inactive");
		expect(mocks.getRun).not.toHaveBeenCalled();
	});

	it("only restores the same upload claim after dispatch rejection", async () => {
		const claimedAt = new Date("2026-09-01T00:00:00Z");
		await restoreLoomImportStartError(
			"video-1",
			"processing",
			claimedAt,
			"Startup rejected",
		);
		expect(mocks.set).toHaveBeenCalledWith(
			expect.objectContaining({
				phase: "error",
				processingError: "Startup rejected",
			}),
		);
		expect(mocks.where).toHaveBeenCalledWith({
			conditions: [
				{ column: "uploadVideoId", value: "video-1" },
				{ column: "phase", value: "processing" },
				{ column: "updatedAt", value: claimedAt },
			],
		});
	});
});
