import { videos, videoUploads } from "@cap/database/cloudflare/schema";
import { nanoId } from "@cap/database/helpers";
import { Video } from "@cap/web-domain";
import { eq } from "drizzle-orm";
import {
	afterAll,
	beforeAll,
	beforeEach,
	describe,
	expect,
	it,
	vi,
} from "vitest";
import { createTestDatabase } from "../../../../packages/database/cloudflare/test-runtime";
import { createTestOwner } from "../helpers/cloudflare-team";

let fixture: Awaited<ReturnType<typeof createTestDatabase>>;
const mocks = vi.hoisted(() => ({
	start: vi.fn(),
	queue: vi.fn(),
	getRun: vi.fn(),
}));
vi.mock("@cap/database/cloudflare/application", () => ({
	db: () => fixture.database,
}));
vi.mock("workflow/api", () => ({ start: mocks.start, getRun: mocks.getRun }));
vi.mock("workflow/runtime", () => ({
	getWorld: () => ({ queue: mocks.queue }),
}));
vi.mock("@/workflows/process-video", () => ({
	processVideoWorkflow: Symbol("processVideoWorkflow"),
}));

import { startVideoProcessingWorkflow } from "@/lib/video-processing";

beforeAll(async () => {
	fixture = await createTestDatabase();
});
afterAll(async () => fixture.dispose());
beforeEach(() => {
	mocks.queue.mockReset().mockResolvedValue({ messageId: "queue-message" });
	mocks.getRun.mockReset().mockReturnValue({
		exists: Promise.resolve(true),
		status: Promise.resolve("pending"),
	});
	mocks.start.mockReset().mockImplementation(
		async (
			_workflow: unknown,
			_payload: unknown,
			options: {
				world: {
					queue: (
						name: string,
						message: { runId: string },
						options: { deploymentId: string },
					) => Promise<unknown>;
				};
			},
		) => {
			await options.world.queue(
				"__wkf_workflow_process",
				{ runId: "wrun_test" },
				{ deploymentId: "deployment-test" },
			);
			return { runId: "wrun_test" };
		},
	);
});
async function input(
	phase:
		| "uploading"
		| "processing"
		| "generating_thumbnail"
		| "complete" = "uploading",
) {
	const owner = await createTestOwner(fixture.database);
	const videoId = Video.VideoId.make(nanoId());
	const rawFileKey = `${owner.id}/${videoId}/raw-upload.webm`;
	await fixture.database.batch([
		fixture.database.insert(videos).values({
			id: videoId,
			ownerId: owner.id,
			orgId: owner.activeOrganizationId,
			source: { type: "webMP4" },
		}),
		fixture.database
			.insert(videoUploads)
			.values({ videoId, phase, mode: "multipart", rawFileKey }),
	]);
	return {
		videoId,
		userId: owner.id,
		rawFileKey,
		bucketId: null,
		processingMessage: "Starting video processing...",
		startFailureMessage: "Video processing could not start.",
		mode: "multipart" as const,
	};
}

describe("D1 video processing dispatch", () => {
	it.each([
		["processing", "already-processing"],
		["generating_thumbnail", "already-processing"],
		["complete", "already-complete"],
	] as const)(
		"does not duplicate workflows during %s",
		async (phase, status) => {
			expect(await startVideoProcessingWorkflow(await input(phase))).toBe(
				status,
			);
			expect(mocks.start).not.toHaveBeenCalled();
		},
	);
	it("starts after atomically claiming upload and stores the workflow receipt", async () => {
		const value = await input();
		expect(await startVideoProcessingWorkflow(value)).toBe("started");
		const [video] = await fixture.database
			.select()
			.from(videos)
			.where(eq(videos.id, value.videoId));
		expect(video?.metadata?.processingRun).toMatchObject({
			dispatch: "accepted",
			workflowRunId: "wrun_test",
			workflowQueue: "__wkf_workflow_process",
			rawFileKey: value.rawFileKey,
		});
		expect(mocks.start.mock.calls[0]?.[1]?.[0]?.processingToken).toBe(
			video?.metadata?.processingRun?.token,
		);
	});
	it("retains uncertain dispatch and requeues the same durable run after a missing acknowledgement", async () => {
		const value = await input();
		mocks.queue.mockRejectedValueOnce(new Error("response lost"));
		await expect(startVideoProcessingWorkflow(value)).rejects.toThrow(
			"Video processing could not start",
		);
		const [video] = await fixture.database
			.select()
			.from(videos)
			.where(eq(videos.id, value.videoId));
		const run = video?.metadata?.processingRun;
		if (!video || !run) throw new Error("Missing receipt");
		expect(run.dispatch).toBe("uncertain");
		await fixture.database
			.update(videos)
			.set({
				metadata: {
					...video.metadata,
					processingRun: { ...run, dispatchStartedAt: Date.now() - 31000 },
				},
			})
			.where(eq(videos.id, value.videoId));
		expect(await startVideoProcessingWorkflow(value)).toBe("started");
		expect(mocks.start).toHaveBeenCalledTimes(1);
		expect(mocks.queue).toHaveBeenLastCalledWith(
			"__wkf_workflow_process",
			{ runId: "wrun_test" },
			{ deploymentId: "deployment-test" },
		);
	});
	it("does not reset a claimed upload to error after an ambiguous start", async () => {
		const value = await input();
		mocks.queue.mockRejectedValueOnce(new Error("response lost"));
		await expect(startVideoProcessingWorkflow(value)).rejects.toThrow();
		expect(
			(
				await fixture.database
					.select()
					.from(videoUploads)
					.where(eq(videoUploads.videoId, value.videoId))
			)[0]?.phase,
		).toBe("processing");
		expect(await startVideoProcessingWorkflow(value)).toBe(
			"already-processing",
		);
	});
	it("requires the observed upload revision before a forced restart", async () => {
		const value = await input();
		await startVideoProcessingWorkflow(value);
		const [upload] = await fixture.database
			.select()
			.from(videoUploads)
			.where(eq(videoUploads.videoId, value.videoId));
		if (!upload) throw new Error("Missing upload");
		const [video] = await fixture.database
			.select()
			.from(videos)
			.where(eq(videos.id, value.videoId));
		const expectedProcessingToken =
			video?.metadata?.processingRun?.token ?? null;
		expect(
			await startVideoProcessingWorkflow({
				...value,
				forceRestart: true,
				expectedUpdatedAt: new Date(0),
				expectedProcessingToken,
			}),
		).toBe("already-processing");
		expect(
			await startVideoProcessingWorkflow({
				...value,
				forceRestart: true,
				expectedUpdatedAt: upload.updatedAt,
				expectedProcessingToken,
			}),
		).toBe("started");
		expect(mocks.start).toHaveBeenCalledTimes(2);
	});
});
