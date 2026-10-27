import { createCloudflareDb } from "@cap/database/cloudflare";
import {
	createD1BridgeBinding,
	handleD1BridgeRequest,
} from "@cap/database/cloudflare/bridge";
import { videos, videoUploads } from "@cap/database/cloudflare/schema";
import { nanoId } from "@cap/database/helpers";
import { eq } from "drizzle-orm";
import { Effect, Option } from "effect";
import {
	afterAll,
	afterEach,
	beforeAll,
	beforeEach,
	describe,
	expect,
	it,
	vi,
} from "vitest";
import { createTestDatabase } from "../../../../packages/database/cloudflare/test-runtime.ts";
import { createTestOwner } from "../helpers/cloudflare-team";

const state = vi.hoisted(() => ({
	database: undefined as
		| Awaited<ReturnType<typeof createTestDatabase>>["database"]
		| undefined,
	process: vi.fn(),
	queue: vi.fn(),
	start: vi.fn(),
	abort: vi.fn(),
}));
vi.mock("server-only", () => ({}));
vi.mock("@cap/database/cloudflare/application", () => ({
	db: () => state.database,
}));
vi.mock("@cap/env", () => ({
	buildEnv: { NEXT_PUBLIC_IS_CAP: "false" },
	serverEnv: () => ({
		LOOM_IMPORTER_URL: "https://synthetic.example",
		MEDIA_SERVER_WEBHOOK_SECRET: "synthetic",
	}),
}));
vi.mock("@/lib/video-processing", () => ({
	startVideoProcessingWorkflow: state.process,
}));
vi.mock("@/lib/workflow-runtime", () => ({
	runWorkflowPromise: Effect.runPromise,
}));
vi.mock("@/workflows/import-loom-video", () => ({
	importLoomVideoWorkflow: vi.fn(),
}));
vi.mock("workflow/api", () => ({
	start: state.start,
	getRun: () => ({ status: Promise.resolve("running") }),
}));
vi.mock("workflow/runtime", () => ({
	getWorld: () => ({ queue: state.queue }),
}));

import { startDeferredLoomProcessing } from "@/lib/loom-deferred-processing";
import {
	getLoomImportArtifactKeys,
	loomImportSourcePublication,
} from "@/lib/loom-import-artifacts";
import { startLoomImportWorkflow } from "@/lib/loom-import-start";
import {
	ensureLoomImportWorkflow,
	ownsLoomImportSource,
	writeLoomImportReceipt,
} from "@/lib/loom-import-state";
import { prepareLoomMultipartUploads } from "@/lib/loom-import-upload";
import { recordLoomMediaDispatch } from "@/lib/loom-media-dispatch";
import { startLoomPreviewGif } from "@/lib/loom-preview-gif";

let fixture: Awaited<ReturnType<typeof createTestDatabase>>;
let video: typeof videos.$inferSelect;
async function currentVideo() {
	const [current] = await fixture.database
		.select()
		.from(videos)
		.where(eq(videos.id, video.id));
	if (!current) throw new Error("Fixture missing");
	return current;
}
const deferred = () =>
	startDeferredLoomProcessing({
		videoId: video.id,
		ownerId: video.ownerId,
		bucketId: null,
		rawFileKey: `${video.ownerId}/${video.id}/raw-upload.webm`,
	});
const upload = (current: typeof videos.$inferSelect = video) =>
	prepareLoomMultipartUploads({
		video: current,
		bucket: {
			provider: "s3",
			multipart: {
				create: (key: string) => Effect.succeed({ UploadId: `upload:${key}` }),
				abort: state.abort,
			},
		} as unknown as Parameters<typeof prepareLoomMultipartUploads>[0]["bucket"],
		attemptId: "run:0",
		sourceKey: `${video.ownerId}/${video.id}/raw-upload.webm`,
		webhookBaseUrl: "https://synthetic.example",
		webhookSecret: "synthetic",
	});

describe("Loom dispatch and upload state on D1", () => {
	beforeAll(async () => {
		fixture = await createTestDatabase();
	});
	afterAll(async () => fixture.dispose());
	afterEach(() => {
		vi.unstubAllGlobals();
		vi.unstubAllEnvs();
	});
	beforeEach(async () => {
		vi.stubEnv("CAP_RUNTIME", "cloudflare");
		state.database = fixture.database;
		state.process.mockReset().mockResolvedValue("started");
		state.queue.mockReset().mockResolvedValue(undefined);
		state.abort.mockReset().mockReturnValue(Effect.void);
		state.start
			.mockReset()
			.mockImplementation(async (_workflow, _args, options) => {
				await options.world.queue("loom-queue", { runId: "run" });
			});
		const owner = await createTestOwner(fixture.database);
		const id = nanoId() as typeof videos.$inferInsert.id;
		const [row] = await fixture.database
			.insert(videos)
			.values({
				id,
				ownerId: owner.id,
				orgId: owner.activeOrganizationId,
				name: "Loom fixture",
				source: { type: "webMP4" },
				metadata: {
					summary: "Preserved summary",
					loomDeferredProcessing: {
						status: "pending",
						rawFileKey: `${owner.id}/${id}/raw-upload.webm`,
					},
				},
			})
			.returning();
		if (!row) throw new Error("Fixture missing");
		video = row;
		await fixture.database
			.insert(videoUploads)
			.values({ videoId: video.id, phase: "uploading" });
	});
	it("claims deferred original-media processing once and publishes its upload row in the same batch", async () => {
		const results = await Promise.all(Array.from({ length: 5 }, deferred));
		expect(results.filter((result) => result === "started")).toHaveLength(1);
		expect(state.process).toHaveBeenCalledTimes(1);
		expect(
			(await currentVideo()).metadata?.loomDeferredProcessing?.status,
		).toBe("started");
		expect(
			await fixture.database
				.select()
				.from(videoUploads)
				.where(eq(videoUploads.videoId, video.id)),
		).toMatchObject([
			{
				phase: "uploading",
				rawFileKey: `${video.ownerId}/${video.id}/raw-upload.webm`,
			},
		]);
	});
	it("keeps a deferred claim when processing delivery is uncertain", async () => {
		state.process.mockRejectedValueOnce(new Error("queue timed out"));
		await expect(deferred()).rejects.toThrow("queue timed out");
		expect(
			(await currentVideo()).metadata?.loomDeferredProcessing?.status,
		).toBe("started");
		expect(await deferred()).toBe("already-started");
		expect(state.process).toHaveBeenCalledTimes(1);
	});
	it("does not start a deferred conversion while an owner reassignment holds a lease", async () => {
		await fixture.database
			.update(videos)
			.set({
				metadata: {
					...video.metadata,
					loomReassignClaim: {
						token: "move-token",
						at: new Date().toISOString(),
					},
				},
			})
			.where(eq(videos.id, video.id));
		expect(await deferred()).toBe("already-started");
		expect(state.process).not.toHaveBeenCalled();
	});
	it("merges workflow and media receipts without replacing sibling metadata", async () => {
		await startLoomImportWorkflow({
			videoId: video.id,
			userId: video.ownerId,
			rawFileKey: `${video.ownerId}/${video.id}/raw-upload.webm`,
			bucketId: null,
			loomVideoId: "a".repeat(32),
		});
		await recordLoomMediaDispatch({
			videoId: video.id,
			userId: video.ownerId,
			runId: "run",
			attemptId: "run:0",
			state: "accepted",
			jobId: "job",
			worker: "media",
		});
		expect((await currentVideo()).metadata).toMatchObject({
			summary: "Preserved summary",
			loomImportRun: {
				runId: "run",
				dispatch: "accepted",
				mediaDispatch: { attemptId: "run:0", jobId: "job" },
			},
		});
	});
	it("recovers a committed multipart receipt whose database acknowledgement was lost", async () => {
		let injected = false;
		state.database = createCloudflareDb(
			createD1BridgeBinding({
				fetch: async (request) => {
					const text = await request.clone().text();
					const response = await handleD1BridgeRequest(
						request,
						fixture.binding,
					);
					if (
						!injected &&
						text.includes("update") &&
						text.includes("loomImportUpload")
					) {
						injected = true;
						throw new Error("response lost");
					}
					return response;
				},
			}),
		);
		expect(await upload()).toMatchObject({
			outputUpload: { loomImportAttemptId: "run:0" },
		});
		expect(injected).toBe(true);
		expect(state.abort).not.toHaveBeenCalled();
		expect((await currentVideo()).metadata?.loomImportUpload?.attemptId).toBe(
			"run:0",
		);
	});
	it("keeps multipart reservations on an unresolved database transport failure", async () => {
		state.database = createCloudflareDb(
			createD1BridgeBinding({
				fetch: async () => {
					throw new Error("database unavailable");
				},
			}),
		);
		await expect(upload()).rejects.toThrow();
		expect(state.abort).not.toHaveBeenCalled();
	});
	it("fences source replacements and publishes receipt-bound immutable outputs", async () => {
		const identity = {
			videoId: video.id,
			userId: video.ownerId,
			bucketId: null,
			rawFileKey: `${video.ownerId}/${video.id}/raw-upload.webm`,
		};
		await ensureLoomImportWorkflow(fixture.database, identity, "run");
		const current = await currentVideo();
		expect(ownsLoomImportSource(current, "run")).toBe(true);
		expect(
			await writeLoomImportReceipt(
				fixture.database,
				identity,
				{ runId: "other", dispatch: "pending" },
				null,
			),
		).toBe(false);
		const keys = getLoomImportArtifactKeys(video.ownerId, video.id, "run:0");
		expect(keys.outputKey).toContain("/.recording/outputs/loom-");
		expect(keys.outputKey).not.toBe(
			getLoomImportArtifactKeys(video.ownerId, video.id, "run:1").outputKey,
		);
		await fixture.database
			.update(videos)
			.set({
				metadata: {
					...current.metadata,
					loomImportRun: {
						...current.metadata?.loomImportRun,
						runId: "run",
						dispatch: "accepted",
						mediaDispatch: {
							attemptId: "run:0",
							state: "accepted",
							jobId: "job",
						},
					},
					loomImportUpload: {
						attemptId: "run:0",
						ownerId: video.ownerId,
						organizationId: video.orgId,
						output: { key: keys.outputKey, uploadId: "upload" },
					},
					aiGenerationStatus: "COMPLETE",
					summary: "Old summary",
				},
			})
			.where(eq(videos.id, video.id));
		const before = await currentVideo();
		await fixture.database
			.update(videos)
			.set(loomImportSourcePublication(before))
			.where(eq(videos.id, video.id));
		const published = await currentVideo();
		expect(ownsLoomImportSource(published, "run")).toBe(true);
		expect(published.source).toMatchObject({ outputKey: keys.outputKey });
		expect(published.metadata?.summary).toBeUndefined();
		expect(published.metadata?.transcriptPublication?.vtt).toBe(false);
		expect(
			ownsLoomImportSource(
				{
					...published,
					storageIntegrationId:
						"moved-integration" as typeof published.storageIntegrationId,
				},
				"run",
			),
		).toBe(false);
		expect(
			loomImportSourcePublication(published).metadata?.transcriptPublication
				?.id,
		).toBe(published.metadata?.transcriptPublication?.id);
		await fixture.database
			.update(videos)
			.set({
				source: {
					type: "desktopMP4",
					outputKey: `${video.ownerId}/${video.id}/.recording/replacement.mp4`,
				},
			})
			.where(eq(videos.id, video.id));
		expect(ownsLoomImportSource(await currentVideo(), "run")).toBe(false);
	});
	it("uses native D1 claim counts when a preview renderer claims and completes work", async () => {
		await fixture.database
			.update(videos)
			.set({
				metadata: { ...video.metadata, loomPreviewGif: { status: "pending" } },
			})
			.where(eq(videos.id, video.id));
		vi.stubGlobal(
			"fetch",
			vi.fn().mockResolvedValue(Response.json({ ok: true })),
		);
		const result = await startLoomPreviewGif({
			video: {
				id: video.id,
				ownerId: video.ownerId,
				duration: Option.some(5),
			} as never,
			getVideoUrl: async () => "https://synthetic.example/video",
			getPreviewPutUrl: async () => "https://synthetic.example/preview",
		});
		expect(result).toBe("complete");
		expect((await currentVideo()).metadata).toMatchObject({
			summary: "Preserved summary",
			loomPreviewGif: { status: "complete" },
		});
	});
});
