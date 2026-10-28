import {
	agentApiOperations,
	s3Buckets,
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
	importer: false,
	download: vi.fn(),
	heads: new Map<string, number>(),
	onHead: undefined as (() => Promise<void>) | undefined,
	videoId: "",
}));
vi.mock("server-only", () => ({}));
vi.mock("@cap/database/cloudflare/application", () => ({
	db: () => state.database,
}));
vi.mock("@cap/env", () => ({
	buildEnv: { NEXT_PUBLIC_IS_CAP: "false" },
	serverEnv: () => ({
		MEDIA_SERVER_URL: "https://media.synthetic.example",
		LOOM_IMPORTER_URL: state.importer
			? "https://importer.synthetic.example"
			: undefined,
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
	getReusableLoomDownloadUrl: (value: string | undefined) => value ?? null,
	getLoomDownloadUrl: state.download,
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
					headObject: (key: string) =>
						Effect.gen(function* () {
							if (state.onHead) yield* Effect.promise(state.onHead);
							const length = state.heads.get(key);
							if (length === undefined)
								return yield* Effect.fail({ name: "NotFound" });
							return { ContentLength: length };
						}),
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
import { VideoProcessingFailedError } from "@/workflows/video-processing-status";

let runtime: Awaited<ReturnType<typeof createTestDatabase>>;
let owner: Awaited<ReturnType<typeof createTestOwner>>;
let video: typeof videos.$inferSelect;
const metadata = { duration: 12, width: 640, height: 360, fps: 30 };
const payload = () => ({
	videoId: video.id,
	userId: video.ownerId,
	bucketId: video.bucket,
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
		state.importer = false;
		state.heads.clear();
		state.onHead = undefined;
		state.download
			.mockReset()
			.mockResolvedValue("https://cdn.loom.com/source.mp4");
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
		state.videoId = video.id;
		await runtime.database
			.insert(videoUploads)
			.values({ videoId: video.id, phase: "processing" });
		state.wait.mockReset().mockImplementation(async () => {
			if (state.onCompletion) await state.onCompletion();
			else {
				const row = await current();
				await runtime.database
					.update(videos)
					.set({
						...metadata,
						...loomImportSourcePublication(
							row,
							row.metadata ?? {},
							metadata.duration,
						),
					})
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
				if (url.includes("/status"))
					return Response.json({
						jobId: "job",
						videoId: state.videoId,
						phase: "error",
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
		expect(row.metadata?.editingBase).toMatchObject({
			version: 1,
			sourceKey: "outputKey" in row.source ? row.source.outputKey : "missing",
			duration: 12,
		});
		expect(row.metadata?.editingBase?.id).toBe(
			row.metadata?.transcriptPublication?.id,
		);
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
	it.each([25.06, 29.97])(
		"publishes final Loom metadata with fractional fps %s",
		async (fps) => {
			state.wait.mockResolvedValue({ ...metadata, fps, duration: 19.198 });
			expect((await importLoomVideoWorkflow(payload())).success).toBe(true);
			expect(await current()).toMatchObject({
				fps: Math.round(fps),
				duration: 19.198,
				source: {
					outputKey: expect.stringContaining("/.recording/outputs/loom-"),
				},
			});
		},
	);
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
	it("reuses the preserved importer WebM when the first conversion fails", async () => {
		state.importer = true;
		state.download.mockResolvedValue("https://cdn.loom.com/source.m3u8");
		let savedKey = "";
		state.wait.mockImplementationOnce(async () => {
			const original = state.jobBodies[0]?.originalUpload as { key: string };
			savedKey = original.key;
			state.heads.set(savedKey, 4096);
			throw new VideoProcessingFailedError("Synthetic conversion failure");
		});
		expect((await importLoomVideoWorkflow(payload())).success).toBe(true);
		expect(state.download).toHaveBeenCalledTimes(1);
		expect(state.jobBodies).toHaveLength(2);
		expect(state.jobBodies[1]?.videoUrl).toBe(
			`https://storage.synthetic.example/${savedKey}`,
		);
		expect(state.jobBodies[1]?.sourceUpload).toBeUndefined();
		expect((await current()).metadata?.loomDeferredProcessing).toEqual({
			rawFileKey: savedKey,
			status: "complete",
		});
		expect(state.remove).not.toHaveBeenCalled();
	});
	it("rejects a saved input when replacement occurs during its storage check", async () => {
		state.heads.set(payload().rawFileKey, 4096);
		const replacementKey = `${video.ownerId}/${video.id}/replacement.mp4`;
		state.onHead = async () => {
			state.onHead = undefined;
			await runtime.database
				.update(videos)
				.set({ source: { type: "webMP4", outputKey: replacementKey } })
				.where(eq(videos.id, video.id));
		};
		await expect(
			importLoomVideoWorkflow({ ...payload(), reuseExistingRawUpload: true }),
		).rejects.toThrow("changed during storage verification");
		expect((await current()).source).toMatchObject({
			outputKey: replacementKey,
		});
		expect(state.jobBodies).toHaveLength(0);
		expect(state.download).not.toHaveBeenCalled();
	});
	it("rejects a saved input when its bucket is disabled during HEAD", async () => {
		const bucketId = nanoId() as typeof s3Buckets.$inferSelect.id;
		await runtime.binding
			.prepare(
				"INSERT INTO s3_buckets (id, ownerId, region, bucketName, accessKeyId, secretAccessKey) VALUES (?, ?, ?, ?, ?, ?)",
			)
			.bind(
				bucketId,
				video.ownerId,
				"synthetic",
				"synthetic",
				"synthetic",
				"synthetic",
			)
			.run();
		await runtime.database
			.update(videos)
			.set({ bucket: bucketId })
			.where(eq(videos.id, video.id));
		video = await current();
		state.heads.set(payload().rawFileKey, 4096);
		state.onHead = async () => {
			state.onHead = undefined;
			await runtime.database
				.update(s3Buckets)
				.set({ active: false })
				.where(eq(s3Buckets.id, bucketId));
		};
		await expect(
			importLoomVideoWorkflow({ ...payload(), reuseExistingRawUpload: true }),
		).rejects.toThrow("storage is unavailable");
		expect(state.jobBodies).toHaveLength(0);
		expect(state.download).not.toHaveBeenCalled();
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
