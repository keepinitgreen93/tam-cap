vi.mock("server-only", () => ({}));

import {
	type CloudflareDatabase,
	createCloudflareDb,
} from "@cap/database/cloudflare";
import { atomic } from "@cap/database/cloudflare/atomic";
import {
	createD1BridgeBinding,
	handleD1BridgeRequest,
} from "@cap/database/cloudflare/bridge";
import * as Db from "@cap/database/cloudflare/schema";
import { createTranscriptInvalidation } from "@cap/database/cloudflare/transcript-publication";
import { Comment, Organisation, S3Bucket, User, Video } from "@cap/web-domain";
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
import { createTestDatabase } from "../../../../packages/database/cloudflare/test-runtime";

const mocks = vi.hoisted(() => ({
	database: undefined as CloudflareDatabase | undefined,
	access: vi.fn(),
	head: vi.fn(),
	target: vi.fn(),
	fetch: vi.fn(),
	auth: vi.fn(),
	queue: vi.fn(),
	start: vi.fn(),
	copy: vi.fn(),
	deleteObjects: vi.fn(),
}));
vi.mock("@cap/database/cloudflare/application", () => ({
	db: () => {
		if (!mocks.database) throw Error("Missing test database");
		return mocks.database;
	},
}));
vi.mock("@cap/database/auth/session", () => ({ getCurrentUser: mocks.auth }));
vi.mock("@cap/env", () => ({
	serverEnv: () => ({
		NEXTAUTH_SECRET: "test-only-desktop-reupload-signing-key",
		MEDIA_SERVER_URL: "https://media.test",
		MEDIA_SERVER_WEBHOOK_SECRET: "secret",
		WEB_URL: "https://cap.test",
	}),
	buildEnv: { NEXT_PUBLIC_IS_CAP: "false" },
	NODE_ENV: "test",
}));
vi.mock("@cap/web-backend", () => ({
	Storage: { getAccessForVideo: mocks.access },
	AwsCredentials: {},
}));
vi.mock("@cap/web-backend/src/Storage/index", () => ({
	Storage: { getAccessForVideo: mocks.access },
}));
vi.mock("@/lib/server", () => ({ runPromise: Effect.runPromise }));
vi.mock("@/lib/workflow-runtime", () => ({
	runWorkflowPromise: Effect.runPromise,
}));
vi.mock("@/lib/queue-video-transcription", () => ({
	queueVideoTranscription: mocks.queue,
}));
vi.mock("@/lib/transcribe", () => ({ transcribeVideo: vi.fn() }));
vi.mock("workflow/api", () => ({ start: mocks.start }));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
vi.mock("@/utils/flags", () => ({ isAiGenerationEnabled: async () => false }));
vi.mock("@/lib/messenger/constants", () => ({
	MESSENGER_ADMIN_EMAIL: "admin@cap.test",
}));

import {
	getVideoReplaceUploadUrl,
	invalidateVideoCache,
} from "@/actions/admin/replace-video";
import { getVideoDownloadInfo } from "@/actions/videos/download";
import {
	restoreVideoToOriginal,
	saveVideoEdits,
} from "@/actions/videos/save-edits";
import {
	prepareDesktopReupload,
	publishDesktopReupload,
} from "@/lib/desktop-reupload";
import {
	createDesktopReuploadKey,
	createDesktopReuploadToken,
	decodeDesktopReuploadToken,
} from "@/lib/desktop-reupload-token";
import { getEditSourceKey } from "@/lib/video-edit-processing";
import { decodeStorageVideo } from "@/lib/video-storage";
import {
	saveEditResultAndComplete,
	startMediaServerEditJob,
	verifyRenderedEditOutput,
} from "@/workflows/edit-video";

let runtime: Awaited<ReturnType<typeof createTestDatabase>>;
let video: typeof Db.videos.$inferSelect;
let sequence = 0;
let loseResponse = false;
const rendered = { duration: 5, width: 320, height: 180, fps: 30 };
const editSpec = {
	version: 1 as const,
	sourceDuration: 10,
	keepRanges: [{ start: 0, end: 5 }],
};
const operation = {
	token: "11111111-1111-4111-8111-111111111111",
	startedAt: "2026-09-08T12:00:00.000Z",
};
beforeAll(async () => {
	runtime = await createTestDatabase();
	await runtime.database.insert(Db.users).values({
		id: User.UserId.make("admin"),
		email: "admin@cap.test",
		emailVerified: new Date(),
		activeOrganizationId: Organisation.OrganisationId.make(""),
	});
	mocks.database = createCloudflareDb(
		createD1BridgeBinding({
			fetch: async (request) => {
				const payload = (await request.clone().json()) as {
					operation: string;
					statements?: { sql: string }[];
				};
				const response = await handleD1BridgeRequest(request, runtime.binding);
				if (
					payload.operation === "batch" &&
					loseResponse &&
					response.ok &&
					payload.statements?.some((statement) =>
						statement.sql.startsWith('update "videos"'),
					)
				) {
					loseResponse = false;
					throw new Error("Committed publication response lost");
				}
				return response;
			},
		}),
	);
}, 60000);
afterAll(async () => runtime?.dispose());
afterEach(() => {
	vi.unstubAllGlobals();
	vi.unstubAllEnvs();
});
beforeEach(async () => {
	vi.clearAllMocks();
	const suffix = String(++sequence),
		ownerId = User.UserId.make(`o${suffix}`),
		orgId = Organisation.OrganisationId.make(`org${suffix}`),
		id = Video.VideoId.make(`v${suffix}`);
	await runtime.database.insert(Db.users).values({
		id: ownerId,
		email: `${suffix}@replacement.test`,
		activeOrganizationId: orgId,
	});
	await runtime.database
		.insert(Db.organizations)
		.values({ id: orgId, ownerId, name: "Team" });
	await runtime.database.insert(Db.videos).values({
		id,
		ownerId,
		orgId,
		source: {
			type: "desktopMP4",
			outputKey: `${ownerId}/${id}/.recording/outputs/old.mp4`,
			thumbnailKey: "old-thumbnail",
			previewKey: "old-preview",
		},
		metadata: {
			customCreatedAt: "2020-01-01T00:00:00Z",
			summary: "old summary",
		},
	});
	video = await readVideo();
	mocks.auth.mockResolvedValue({
		id: "admin",
		email: "admin@cap.test",
		emailVerified: new Date(),
	});
	mocks.start.mockReset().mockResolvedValue({ runId: "edit-run" });
	mocks.copy.mockReset().mockReturnValue(Effect.void);
	mocks.deleteObjects.mockReset().mockReturnValue(Effect.void);
	mocks.queue.mockImplementation(async () => {
		await runtime.database
			.update(Db.videos)
			.set({ transcriptionStatus: "PROCESSING" })
			.where(eq(Db.videos.id, video.id));
	});
	mocks.head.mockReturnValue(
		Effect.succeed({ ETag: '"new-output"', ContentLength: 1000 }),
	);
	mocks.target.mockReturnValue(
		Effect.succeed({
			type: "put",
			url: "https://storage.test/upload",
			headers: { "Content-Type": "video/mp4" },
		}),
	);
	mocks.access.mockImplementation((_video, options) =>
		Effect.succeed([
			{
				provider: "s3",
				headObject: mocks.head,
				createUploadTarget: mocks.target,
				copyObject: mocks.copy,
				deleteObjects: mocks.deleteObjects,
				getObject: () => Effect.succeed(Option.none()),
				getSignedObjectUrl: (key: string) =>
					Effect.succeed(`https://storage.test/download/${key}`),
				listObjects: () => Effect.succeed({ Contents: [] }),
				getInternalSignedObjectUrl: (key: string) =>
					Effect.succeed(
						`https://storage.test/${options?.resolvePublishedOutput === false ? "canonical" : "published"}/${key}`,
					),
			},
		]),
	);
	mocks.fetch.mockImplementation(async () =>
		Response.json({ metadata: rendered }),
	);
	vi.stubGlobal("fetch", mocks.fetch);
	async function readVideo() {
		const [row] = await runtime.database
			.select()
			.from(Db.videos)
			.where(eq(Db.videos.id, id));
		if (!row) throw Error("Missing fixture");
		return row;
	}
});
async function current() {
	const [row] = await runtime.database
		.select()
		.from(Db.videos)
		.where(eq(Db.videos.id, video.id));
	if (!row) throw Error("Missing video");
	return row;
}
async function change(values: Partial<typeof Db.videos.$inferInsert>) {
	await runtime.database
		.update(Db.videos)
		.set(values)
		.where(eq(Db.videos.id, video.id));
	video = await current();
}
async function replacement() {
	const original = decodeStorageVideo(video),
		outputKey = createDesktopReuploadKey(original);
	const token = decodeDesktopReuploadToken(
		createDesktopReuploadToken(original, {
			uploadId: "provider-upload",
			provider: "s3",
			outputKey,
		}),
	);
	if (!token) throw Error("Missing token");
	await runtime.database
		.insert(Db.videoUploads)
		.values({ videoId: video.id, rawFileKey: outputKey });
	return { original, token };
}
async function plan(
	original: Parameters<typeof prepareDesktopReupload>[1],
	token: Parameters<typeof prepareDesktopReupload>[2],
) {
	const invalidation = createTranscriptInvalidation();
	return atomic(runtime.database, async (snapshot) => ({
		statements: [],
		result: await prepareDesktopReupload(
			snapshot,
			original,
			token,
			invalidation,
		),
	}));
}

describe("desktop reupload publication on D1", () => {
	it("replaces an edited recording with a new editing base and retires its prior edit spec atomically", async () => {
		const oldOriginal = `${video.ownerId}/${video.id}/source/original.mp4`;
		await change({ duration: 5 });
		await runtime.database
			.insert(Db.videoEdits)
			.values({ videoId: video.id, sourceKey: oldOriginal, editSpec });
		await runtime.database.insert(Db.comments).values({
			id: Comment.CommentId.make(`replacec${sequence}`),
			authorId: video.ownerId,
			videoId: video.id,
			type: "text",
			content: "Keep this comment",
			timestamp: 3,
		});
		const { original, token } = await replacement();
		await publishDesktopReupload(runtime.database, original, token, {
			duration: 30,
			width: 640,
			height: 360,
			fps: 30,
		});
		const replaced = await current();
		expect
			.soft(getEditSourceKey(replaced.ownerId, replaced.id, replaced.metadata))
			.toBe(token.outputKey);
		expect
			.soft(
				await runtime.database
					.select()
					.from(Db.videoEdits)
					.where(eq(Db.videoEdits.videoId, video.id)),
			)
			.toEqual([]);
		expect(
			await runtime.database
				.select()
				.from(Db.comments)
				.where(eq(Db.comments.videoId, video.id)),
		).toMatchObject([{ content: "Keep this comment", timestamp: 3 }]);
		expect(replaced).toMatchObject({
			id: video.id,
			duration: 30,
			source: { outputKey: token.outputKey },
		});
	});
	it("plans media and transcript invalidation without changing stored playback", async () => {
		const before = await current();
		const { original, token } = await replacement();
		const result = await plan(original, token);
		expect(result).toMatchObject({
			source: { type: "desktopMP4", outputKey: token.outputKey },
			metadata: {
				customCreatedAt: "2020-01-01T00:00:00Z",
				transcriptPublication: { vtt: false, edit: false },
			},
			transcriptionStatus: null,
		});
		expect(result?.metadata).not.toHaveProperty("summary");
		expect(await current()).toEqual(before);
		expect(mocks.head).not.toHaveBeenCalled();
	});
	it.each(["desktopSegments", "webMP4"] as const)(
		"publishes a %s replacement",
		async (type) => {
			await change({ source: { type } });
			const { original, token } = await replacement();
			await publishDesktopReupload(runtime.database, original, token);
			expect((await current()).source).toEqual({
				type: type === "webMP4" ? "webMP4" : "desktopMP4",
				outputKey: token.outputKey,
			});
		},
	);
	it.each(["bucket", "storageIntegrationId", "ownerId"] as const)(
		"rejects changed %s before publication",
		async (field) => {
			const { original, token } = await replacement();
			if (field === "storageIntegrationId")
				await runtime.binding
					.prepare(
						"INSERT INTO storage_integrations (id, ownerId, provider, displayName, encryptedConfig) VALUES (?, ?, 'googleDrive', 'Changed storage', '{}')",
					)
					.bind("changed", video.ownerId)
					.run();
			await change({ [field]: "changed" });
			const before = await current();
			await expect(plan(original, token)).rejects.toThrow("storage changed");
			expect(await current()).toEqual(before);
		},
	);
	it.each([null, "newer-upload"])(
		"rejects a canceled or superseded upload %s",
		async (rawFileKey) => {
			const { original, token } = await replacement();
			await runtime.database
				.update(Db.videoUploads)
				.set({ rawFileKey })
				.where(eq(Db.videoUploads.videoId, video.id));
			await expect(plan(original, token)).rejects.toThrow(
				"canceled or superseded",
			);
		},
	);
	it("rejects an old completion after another source publication", async () => {
		const { original, token } = await replacement();
		await change({ source: { type: "desktopMP4", outputKey: "newer.mp4" } });
		await expect(plan(original, token)).rejects.toThrow("source changed");
	});
	it("normalizes source field ordering", async () => {
		const { original, token } = await replacement();
		await change({
			source: JSON.parse(
				JSON.stringify(
					Object.fromEntries(Object.entries(video.source).reverse()),
				),
			),
		});
		expect(await plan(original, token)).toMatchObject({
			source: { outputKey: token.outputKey },
		});
	});
	it("replays the committed publication without rotating its transcript or retired generation", async () => {
		const { original, token } = await replacement();
		expect(
			await publishDesktopReupload(runtime.database, original, token),
		).toBe(true);
		const before = await current();
		const jobs = await runtime.database
			.select()
			.from(Db.videoProcessingJobs)
			.where(eq(Db.videoProcessingJobs.videoId, video.id));
		expect(
			await publishDesktopReupload(runtime.database, original, token),
		).toBe(false);
		expect(await current()).toEqual(before);
		expect(
			await runtime.database
				.select()
				.from(Db.videoProcessingJobs)
				.where(eq(Db.videoProcessingJobs.videoId, video.id)),
		).toEqual(jobs);
	});
	it("still validates storage for already-published retries", async () => {
		const { original, token } = await replacement();
		await publishDesktopReupload(runtime.database, original, token);
		await change({ bucket: S3Bucket.S3BucketId.make("changed") });
		await expect(
			publishDesktopReupload(runtime.database, original, token),
		).rejects.toThrow("storage changed");
	});
	it("rolls back the retirement when publication fails in the same D1 batch", async () => {
		const { original, token } = await replacement();
		const before = await current();
		await runtime.binding
			.prepare(
				`CREATE TRIGGER fail_replacement BEFORE UPDATE ON videos WHEN NEW.id = '${video.id}' BEGIN SELECT RAISE(ABORT,'publication failure'); END`,
			)
			.run();
		try {
			await expect(
				publishDesktopReupload(runtime.database, original, token),
			).rejects.toThrow();
		} finally {
			await runtime.binding.prepare("DROP TRIGGER fail_replacement").run();
		}
		expect(await current()).toEqual(before);
		expect(
			await runtime.database
				.select()
				.from(Db.videoProcessingJobs)
				.where(eq(Db.videoProcessingJobs.videoId, video.id)),
		).toEqual([]);
	});
	it("rejects tombstoned organizations without publishing", async () => {
		const { original, token } = await replacement();
		await runtime.database
			.update(Db.organizations)
			.set({ tombstoneAt: new Date() })
			.where(eq(Db.organizations.id, video.orgId));
		await expect(
			publishDesktopReupload(runtime.database, original, token),
		).rejects.toThrow();
		expect((await current()).source).toEqual(video.source);
	});
});

describe("edited recording publication", () => {
	it.each(
		(["desktopMP4", "webMP4"] as const).flatMap((type) =>
			[30, 25.06, 29.97].map((fps) => ({ type, fps })),
		),
	)(
		"clears stale derivatives and replays the edit with integer fps: %j",
		async ({ type, fps }) => {
			const renderedMetadata = { ...rendered, fps };
			const source = {
				type,
				audioLevelSourceKey: "old.mp4",
				audioLevelOutputKey: "audio.mp4",
			};
			const sourceKey = `${video.ownerId}/${video.id}/edit-original.mp4`;
			await change({
				source,
				metadata: {
					customCreatedAt: "2020-01-01T00:00:00Z",
					editProcessing: {
						...operation,
						ownerId: video.ownerId,
						bucket: null,
						storageIntegrationId: null,
						sourceKey,
						source: JSON.stringify(source),
						dispatch: "accepted",
					},
				},
			});
			await runtime.database.insert(Db.videoUploads).values({
				videoId: video.id,
				rawFileKey: sourceKey,
				startedAt: new Date(operation.startedAt),
				phase: "complete",
			});
			await saveEditResultAndComplete(
				video.id,
				sourceKey,
				editSpec,
				editSpec,
				renderedMetadata,
				operation,
			);
			const result = await current();
			expect(result.fps).toBe(Math.round(fps));
			expect(result.source).toMatchObject({
				type,
				outputKey: `${video.ownerId}/${video.id}/.recording/outputs/edit-${operation.token}/result.mp4`,
			});
			expect(result.source).not.toHaveProperty("audioLevelOutputKey");
			expect(result.metadata?.customCreatedAt).toBe("2020-01-01T00:00:00Z");
			await saveEditResultAndComplete(
				video.id,
				sourceKey,
				editSpec,
				editSpec,
				renderedMetadata,
				operation,
			);
			expect(await current()).toEqual(result);
		},
	);
	it.each([undefined, operation])(
		"probes the selected edit output instead of previous published media: %j",
		async (edit) => {
			await verifyRenderedEditOutput(
				video.id,
				video.ownerId,
				editSpec,
				rendered,
				edit,
			);
			const key = edit
				? `${video.ownerId}/${video.id}/.recording/outputs/edit-${operation.token}/result.mp4`
				: `${video.ownerId}/${video.id}/result.mp4`;
			expect(mocks.fetch).toHaveBeenCalledWith(
				"https://media.test/video/probe",
				expect.objectContaining({
					body: JSON.stringify({
						videoUrl: `https://storage.test/canonical/${key}`,
					}),
				}),
			);
		},
	);
});

describe("intentional administrator replacements", () => {
	it("resumes transcription after a lost publication response without republishing", async () => {
		const prepared = await getVideoReplaceUploadUrl(video.id);
		loseResponse = true;
		await expect(
			invalidateVideoCache(video.id, prepared.replacementToken),
		).rejects.toThrow("response lost");
		const committed = await current();
		expect(mocks.queue).not.toHaveBeenCalled();
		await invalidateVideoCache(video.id, prepared.replacementToken);
		const resumed = await current();
		expect(resumed.source).toEqual(committed.source);
		expect(resumed.metadata).toEqual(committed.metadata);
		expect(mocks.queue).toHaveBeenCalledOnce();
	});
	it.each(["desktopMP4", "desktopSegments", "webMP4"] as const)(
		"publishes %s with an immutable token and no CloudFront dependency",
		async (type) => {
			await change({
				source: {
					type,
					audioLevelSourceKey: "old.mp4",
					audioLevelOutputKey: "audio.mp4",
				},
			});
			const before = await current();
			const prepared = await getVideoReplaceUploadUrl(video.id);
			expect(await current()).toEqual(before);
			const token = decodeDesktopReuploadToken(prepared.replacementToken);
			expect(token).not.toBeNull();
			expect(mocks.target).toHaveBeenCalledWith(
				token?.outputKey,
				expect.objectContaining({ method: "put", ifNoneMatch: "*" }),
			);
			await invalidateVideoCache(video.id, prepared.replacementToken);
			const result = await current();
			expect(result.source).toEqual({
				type: type === "webMP4" ? "webMP4" : "desktopMP4",
				outputKey: token?.outputKey,
			});
			expect(mocks.queue).toHaveBeenCalledOnce();
			await invalidateVideoCache(video.id, prepared.replacementToken);
			expect(mocks.queue).toHaveBeenCalledOnce();
			expect(await current()).toEqual(result);
		},
	);
	it("preserves playback if the new object is empty", async () => {
		const prepared = await getVideoReplaceUploadUrl(video.id);
		mocks.head.mockReturnValue(Effect.succeed({ ContentLength: 0 }));
		await expect(
			invalidateVideoCache(video.id, prepared.replacementToken),
		).rejects.toThrow("not finished uploading");
		expect((await current()).source).toEqual(video.source);
	});
	it("rolls back its upload reservation on signing failure", async () => {
		mocks.target.mockReturnValue(Effect.fail(new Error("Signing unavailable")));
		await expect(getVideoReplaceUploadUrl(video.id)).rejects.toThrow(
			"Signing unavailable",
		);
		expect(
			await runtime.database
				.select()
				.from(Db.videoUploads)
				.where(eq(Db.videoUploads.videoId, video.id)),
		).toEqual([]);
		expect((await current()).source).toEqual(video.source);
	});
	it("rejects concurrent replacement reservation and changed ownership", async () => {
		const results = await Promise.allSettled([
			getVideoReplaceUploadUrl(video.id),
			getVideoReplaceUploadUrl(video.id),
		]);
		expect(
			results.filter((result) => result.status === "fulfilled"),
		).toHaveLength(1);
		const result = results.find((value) => value.status === "fulfilled");
		if (result?.status !== "fulfilled") throw Error("No accepted replacement");
		await change({ ownerId: User.UserId.make("another-owner") });
		await expect(
			invalidateVideoCache(video.id, result.value.replacementToken),
		).rejects.toThrow();
	});
});
describe("edit dispatch acceptance", () => {
	it("retries only an explicit capacity rejection", async () => {
		mocks.fetch.mockResolvedValue(
			Response.json({ code: "SERVER_BUSY" }, { status: 503 }),
		);
		await expect(
			startMediaServerEditJob("https://media.test", { videoId: "video" }),
		).resolves.toEqual({ status: "capacity" });
		expect(mocks.fetch).toHaveBeenCalledOnce();
	});
	it("treats proxy failures as uncertain acceptance", async () => {
		mocks.fetch.mockResolvedValue(
			Response.json({ error: "Gateway timeout" }, { status: 504 }),
		);
		await expect(
			startMediaServerEditJob("https://media.test", { videoId: "video" }),
		).rejects.toThrow("uncertain");
		expect(mocks.fetch).toHaveBeenCalledOnce();
	});
	it("does not resend a request after a lost response", async () => {
		mocks.fetch.mockRejectedValue(new Error("Connection reset"));
		await expect(
			startMediaServerEditJob("https://media.test", { videoId: "video" }),
		).rejects.toThrow("Connection reset");
		expect(mocks.fetch).toHaveBeenCalledOnce();
	});
	it("accepts only responses containing the worker identity", async () => {
		mocks.fetch.mockResolvedValue(Response.json({ jobId: "worker-1" }));
		await expect(
			startMediaServerEditJob("https://media.test", { videoId: "video" }),
		).resolves.toEqual({ status: "accepted", jobId: "worker-1" });
	});
});
it("edits and restores the replacement timeline without consulting the previous canonical original", async () => {
	const oldOriginal = `${video.ownerId}/${video.id}/source/original.mp4`;
	await change({ duration: 5 });
	await runtime.database
		.insert(Db.videoEdits)
		.values({ videoId: video.id, sourceKey: oldOriginal, editSpec });
	const { original, token } = await replacement();
	await publishDesktopReupload(runtime.database, original, token, {
		duration: 30,
		width: 640,
		height: 360,
		fps: 30,
	});
	mocks.auth.mockResolvedValue({
		id: video.ownerId,
		email: "owner@replacement.test",
		activeOrganizationId: video.orgId,
		emailVerified: new Date(),
	});
	expect(
		await saveVideoEdits(video.id, {
			version: 1,
			sourceDuration: 30,
			keepRanges: [{ start: 0, end: 20 }],
		}),
	).toEqual({ success: true });
	expect(mocks.start).toHaveBeenCalledOnce();
	const first = mocks.start.mock.calls[0]?.[1]?.[0] as Parameters<
		typeof import("@/workflows/edit-video").editVideoWorkflow
	>[0];
	expect(first).toMatchObject({
		sourceKey: token.outputKey,
		previousSpec: { sourceDuration: 30, keepRanges: [{ start: 0, end: 30 }] },
		editSpec: { sourceDuration: 30, keepRanges: [{ start: 0, end: 20 }] },
	});
	expect(mocks.copy).not.toHaveBeenCalled();
	expect(mocks.deleteObjects).not.toHaveBeenCalled();
	await runtime.database
		.update(Db.videoUploads)
		.set({ phase: "complete", processingProgress: 100 })
		.where(eq(Db.videoUploads.videoId, video.id));
	await saveEditResultAndComplete(
		video.id,
		first.sourceKey,
		first.previousSpec,
		first.editSpec,
		{ duration: 20, width: 640, height: 360, fps: 30 },
		first.operation,
	);
	expect(await getVideoDownloadInfo(video.id, "original")).toMatchObject({
		success: true,
		downloadUrl: `https://storage.test/download/${token.outputKey}`,
	});
	expect((await current()).metadata?.editingBase?.sourceKey).toBe(
		token.outputKey,
	);
	expect(await restoreVideoToOriginal(video.id)).toEqual({ success: true });
	const restored = mocks.start.mock.calls.at(-1)?.[1]?.[0] as Parameters<
		typeof import("@/workflows/edit-video").editVideoWorkflow
	>[0];
	expect(restored).toMatchObject({
		sourceKey: token.outputKey,
		editSpec: { sourceDuration: 30, keepRanges: [{ start: 0, end: 30 }] },
	});
	expect(mocks.head.mock.calls.map(([key]) => key)).not.toContain(oldOriginal);
});
it("rolls back the new editing base and source when old edit retirement cannot commit", async () => {
	const oldOriginal = `${video.ownerId}/${video.id}/source/original.mp4`;
	await change({ duration: 5 });
	await runtime.database
		.insert(Db.videoEdits)
		.values({ videoId: video.id, sourceKey: oldOriginal, editSpec });
	const { original, token } = await replacement(),
		before = await current();
	await runtime.binding
		.prepare(
			`CREATE TRIGGER fail_edit_retirement BEFORE DELETE ON video_edits WHEN OLD.videoId = '${video.id}' BEGIN SELECT RAISE(ABORT,'edit retirement failure'); END`,
		)
		.run();
	try {
		await expect(
			publishDesktopReupload(runtime.database, original, token, {
				duration: 30,
			}),
		).rejects.toThrow();
	} finally {
		await runtime.binding.prepare("DROP TRIGGER fail_edit_retirement").run();
	}
	expect(await current()).toEqual(before);
	expect(
		await runtime.database
			.select()
			.from(Db.videoEdits)
			.where(eq(Db.videoEdits.videoId, video.id)),
	).toMatchObject([{ sourceKey: oldOriginal, editSpec }]);
	expect(
		await runtime.database
			.select()
			.from(Db.videoUploads)
			.where(eq(Db.videoUploads.videoId, video.id)),
	).toMatchObject([{ rawFileKey: token.outputKey }]);
	expect(mocks.deleteObjects).not.toHaveBeenCalled();
});
it("rejects a pending edit after its editing-base generation changes", async () => {
	const { original, token } = await replacement();
	await publishDesktopReupload(runtime.database, original, token, {
		duration: 30,
	});
	mocks.auth.mockResolvedValue({
		id: video.ownerId,
		email: "owner@replacement.test",
		activeOrganizationId: video.orgId,
	});
	await saveVideoEdits(video.id, {
		version: 1,
		sourceDuration: 30,
		keepRanges: [{ start: 0, end: 20 }],
	});
	const edit = mocks.start.mock.calls[0]?.[1]?.[0] as Parameters<
		typeof import("@/workflows/edit-video").editVideoWorkflow
	>[0];
	const row = await current();
	if (!row.metadata?.editingBase) throw Error("Missing editing base");
	await change({
		metadata: {
			...row.metadata,
			editingBase: { ...row.metadata.editingBase, id: crypto.randomUUID() },
		},
	});
	await runtime.database
		.update(Db.videoUploads)
		.set({ phase: "complete" })
		.where(eq(Db.videoUploads.videoId, video.id));
	const before = await current();
	await expect(
		saveEditResultAndComplete(
			video.id,
			edit.sourceKey,
			edit.previousSpec,
			edit.editSpec,
			{ duration: 20, width: 640, height: 360, fps: 30 },
			edit.operation,
		),
	).rejects.toThrow();
	expect(await current()).toEqual(before);
	expect(
		await runtime.database
			.select()
			.from(Db.videoEdits)
			.where(eq(Db.videoEdits.videoId, video.id)),
	).toEqual([]);
});
it("probes the new immutable replacement instead of retaining old clip dimensions", async () => {
	await change({ duration: 5 });
	const prepared = await getVideoReplaceUploadUrl(video.id),
		token = decodeDesktopReuploadToken(prepared.replacementToken);
	if (!token) throw Error("Missing token");
	mocks.fetch.mockImplementation(async () =>
		Response.json({
			metadata: { duration: 30, width: 640, height: 360, fps: 29.97 },
		}),
	);
	await invalidateVideoCache(video.id, prepared.replacementToken);
	expect(await current()).toMatchObject({
		duration: 30,
		width: 640,
		height: 360,
		fps: 30,
		metadata: { editingBase: { sourceKey: token.outputKey, duration: 30 } },
	});
	expect(mocks.fetch).toHaveBeenCalledWith(
		"https://media.test/video/probe",
		expect.objectContaining({
			body: JSON.stringify({
				videoUrl: `https://storage.test/canonical/${token.outputKey}`,
			}),
		}),
	);
});
it("releases only its unpublished reservation after probe failure while retaining working media and edits", async () => {
	const oldOriginal = `${video.ownerId}/${video.id}/source/original.mp4`;
	await change({ duration: 5 });
	await runtime.database
		.insert(Db.videoEdits)
		.values({ videoId: video.id, sourceKey: oldOriginal, editSpec });
	const before = await current(),
		prepared = await getVideoReplaceUploadUrl(video.id);
	mocks.fetch.mockImplementationOnce(async () =>
		Response.json({}, { status: 503 }),
	);
	await expect(
		invalidateVideoCache(video.id, prepared.replacementToken),
	).rejects.toThrow("could not be verified");
	expect(await current()).toEqual(before);
	expect(
		await runtime.database
			.select()
			.from(Db.videoEdits)
			.where(eq(Db.videoEdits.videoId, video.id)),
	).toMatchObject([{ sourceKey: oldOriginal }]);
	expect(
		await runtime.database
			.select()
			.from(Db.videoUploads)
			.where(eq(Db.videoUploads.videoId, video.id)),
	).toEqual([]);
	expect(mocks.deleteObjects).not.toHaveBeenCalled();
	expect(await getVideoReplaceUploadUrl(video.id)).toHaveProperty(
		"replacementToken",
	);
});
it("rechecks the current administrator after replacement probing", async () => {
	vi.stubEnv("CAP_RUNTIME", "cloudflare");
	vi.stubEnv("CAP_OWNER_EMAIL", "admin@cap.test");
	await runtime.database
		.update(Db.users)
		.set({ emailVerified: new Date() })
		.where(eq(Db.users.id, User.UserId.make("admin")));
	const prepared = await getVideoReplaceUploadUrl(video.id),
		before = await current();
	mocks.fetch.mockImplementationOnce(async () => {
		await runtime.database
			.update(Db.users)
			.set({ emailVerified: null })
			.where(eq(Db.users.id, User.UserId.make("admin")));
		return Response.json({
			metadata: { duration: 30, width: 640, height: 360, fps: 30 },
		});
	});
	try {
		await expect(
			invalidateVideoCache(video.id, prepared.replacementToken),
		).rejects.toThrow("Unauthorized");
		expect(await current()).toEqual(before);
	} finally {
		await runtime.database
			.update(Db.users)
			.set({ emailVerified: new Date() })
			.where(eq(Db.users.id, User.UserId.make("admin")));
	}
});
