import {
	agentApiOperations,
	videos,
	videoUploads,
} from "@cap/database/cloudflare/schema";
import { nanoId } from "@cap/database/helpers";
import { eq } from "drizzle-orm";
import { Effect } from "effect";
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
	onCompletion: undefined as (() => Promise<void>) | undefined,
	wait: vi.fn(),
	request: vi.fn(),
	remove: vi.fn(),
	jobBodies: [] as Record<string, unknown>[],
	provider: "s3",
}));
vi.mock("server-only", () => ({}));
vi.mock("@cap/database/cloudflare/application", () => ({
	db: () => state.database,
}));
vi.mock("@cap/env", () => ({
	buildEnv: { NEXT_PUBLIC_IS_CAP: "false" },
	serverEnv: () => ({
		MEDIA_SERVER_URL: "https://media.synthetic.example",
		WEB_URL: "https://web.synthetic.example",
		MEDIA_SERVER_WEBHOOK_SECRET: "synthetic",
	}),
}));
vi.mock("workflow", () => ({
	getWorkflowMetadata: () => ({ workflowRunId: "workflow-run" }),
	createHook: () => ({ dispose: vi.fn() }),
	sleep: async () => undefined,
	FatalError: class FatalError extends Error {},
	RetryableError: class RetryableError extends Error {},
}));
vi.mock("@/workflows/video-processing-status", () => ({
	waitForSignalledVideoProcessing: state.wait,
	VideoProcessingFailedError: class VideoProcessingFailedError extends Error {},
}));
vi.mock("@/lib/loom-download-url", () => ({
	getReusableLoomDownloadUrl: () => "https://cdn.loom.com/source.mp4",
	getLoomDownloadUrl: async () => "https://cdn.loom.com/source.mp4",
	LoomDownloadTemporaryError: class LoomDownloadTemporaryError extends Error {},
}));
vi.mock("@/lib/workflow-runtime", () => ({
	runWorkflowPromise: Effect.runPromise,
}));
vi.mock("@cap/web-backend/src/Storage/index", () => ({
	Storage: {
		getAccessForVideo: () =>
			Effect.succeed([
				{
					provider: state.provider,
					getInternalSignedObjectUrl: (key: string) =>
						Effect.succeed(`https://storage.synthetic.example/${key}`),
					getInternalPresignedPutUrl: (key: string) =>
						Effect.succeed(
							`https://storage.synthetic.example/${key}?put=synthetic`,
						),
					headObject: () => Effect.fail({ name: "NotFound" }),
					deleteObject: state.remove,
					multipart: {
						create: (key: string) =>
							Effect.succeed({ UploadId: `upload:${key}` }),
						abort: () => Effect.void,
					},
				},
			]),
	},
}));

import { loomImportSourcePublication } from "@/lib/loom-import-artifacts";
import { importLoomVideoWorkflow } from "@/workflows/import-loom-video";

let runtime: Awaited<ReturnType<typeof createTestDatabase>>;
let owner: Awaited<ReturnType<typeof createTestOwner>>;
let video: typeof videos.$inferSelect;
const metadata = { duration: 12, width: 640, height: 360, fps: 30 };
const payload = () => ({
	videoId: video.id,
	userId: video.ownerId,
	bucketId: null,
	rawFileKey: `${video.ownerId}/${video.id}/raw-upload.mp4`,
	loomVideoId: "a".repeat(32),
	cleanupRawUpload: true,
});
async function current() {
	const [row] = await runtime.database
		.select()
		.from(videos)
		.where(eq(videos.id, video.id));
	if (!row) throw new Error("Fixture missing");
	return row;
}
describe("Loom import workflow on D1", () => {
	beforeAll(async () => {
		runtime = await createTestDatabase();
		state.database = runtime.database;
	}, 120_000);
	afterAll(async () => runtime.dispose());
	afterEach(() => {
		vi.unstubAllGlobals();
		vi.unstubAllEnvs();
	});
	beforeEach(async () => {
		state.provider = "s3";
		owner = await createTestOwner(runtime.database);
		vi.stubEnv("CAP_RUNTIME", "cloudflare");
		state.onCompletion = undefined;
		state.remove.mockReset();
		state.jobBodies = [];
		const [row] = await runtime.database
			.insert(videos)
			.values({
				id: nanoId() as typeof videos.$inferSelect.id,
				ownerId: owner.id,
				orgId: owner.activeOrganizationId,
				name: "Workflow import",
				source: { type: "webMP4" },
				metadata: { summary: "Old media summary" },
			})
			.returning();
		if (!row) throw new Error("Fixture missing");
		video = row;
		await runtime.database
			.insert(videoUploads)
			.values({ videoId: video.id, phase: "processing" });
		state.wait.mockReset().mockImplementation(async () => {
			if (state.onCompletion) await state.onCompletion();
			else {
				const row = await current();
				await runtime.database
					.update(videos)
					.set({ ...metadata, ...loomImportSourcePublication(row) })
					.where(eq(videos.id, video.id));
			}
			return metadata;
		});
		state.request
			.mockReset()
			.mockImplementation(async (url: string, init?: RequestInit) => {
				if (url.endsWith("/video/status"))
					return Response.json({
						loomMultipartUploads: true,
						loomImportMaxBytes: 10 * 1024 ** 3,
					});
				state.jobBodies.push(
					JSON.parse(String(init?.body)) as Record<string, unknown>,
				);
				return Response.json({ jobId: "job" });
			});
		vi.stubGlobal("fetch", state.request);
	});
	it("publishes immutable output references and retains the source upload", async () => {
		expect((await importLoomVideoWorkflow(payload())).success).toBe(true);
		const row = await current();
		expect(row.source).toMatchObject({
			outputKey: expect.stringContaining("/.recording/outputs/loom-"),
		});
		expect(row.metadata?.summary).toBeUndefined();
		expect(row.metadata?.transcriptPublication?.vtt).toBe(false);
		expect(row.metadata?.loomImportRun?.sourceRevision).toMatch(
			/^[a-f0-9]{64}$/,
		);
		expect(state.remove).not.toHaveBeenCalled();
		expect(
			await runtime.database
				.select()
				.from(videoUploads)
				.where(eq(videoUploads.videoId, video.id)),
		).toEqual([]);
		expect(state.jobBodies[0]?.outputUpload).toMatchObject({
			key: "outputKey" in row.source ? row.source.outputKey : "missing",
		});
	});
	it("publishes immutable signed-PUT references for non-S3 storage", async () => {
		state.provider = "google-drive";
		expect((await importLoomVideoWorkflow(payload())).success).toBe(true);
		expect((await current()).source).toMatchObject({
			outputKey: expect.stringContaining("/.recording/outputs/loom-"),
		});
		expect(state.jobBodies[0]?.outputUpload).toBeUndefined();
		expect(state.jobBodies[0]?.outputPresignedUrl).toEqual(
			expect.stringContaining("/.recording/outputs/loom-"),
		);
	});
	it("does not overwrite replacement source metadata after worker completion", async () => {
		const key = `${video.ownerId}/${video.id}/.recording/replacement.mp4`;
		state.onCompletion = async () => {
			await runtime.database
				.update(videos)
				.set({
					source: { type: "webMP4", outputKey: key },
					width: 444,
					metadata: {
						...(await current()).metadata,
						summary: "Replacement summary",
					},
				})
				.where(eq(videos.id, video.id));
		};
		await expect(importLoomVideoWorkflow(payload())).rejects.toThrow(
			"superseded",
		);
		expect(await current()).toMatchObject({
			source: { outputKey: key },
			width: 444,
			metadata: { summary: "Replacement summary" },
		});
		const [upload] = await runtime.database
			.select()
			.from(videoUploads)
			.where(eq(videoUploads.videoId, video.id));
		expect(upload?.phase).toBe("processing");
	});
	it("claims and completes an agent operation exactly once", async () => {
		const id = nanoId();
		await runtime.database.insert(agentApiOperations).values({
			id,
			userId: owner.id,
			kind: "import_loom",
			resourceId: owner.activeOrganizationId,
			resultResourceId: video.id,
			payload: { videoId: video.id },
		});
		expect(
			(await importLoomVideoWorkflow({ ...payload(), agentOperationId: id }))
				.success,
		).toBe(true);
		const [operation] = await runtime.database
			.select()
			.from(agentApiOperations)
			.where(eq(agentApiOperations.id, id));
		expect(operation).toMatchObject({
			state: "succeeded",
			result: { videoId: video.id },
		});
		await importLoomVideoWorkflow({ ...payload(), agentOperationId: id });
		expect(state.jobBodies).toHaveLength(1);
	});
});
