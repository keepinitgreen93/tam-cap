import {
	folders,
	importedVideos,
	loomMigrationImports,
	loomMigrationRequests,
	organizationMembers,
	organizations,
	spaceMembers,
	spaces,
	spaceVideos,
	users,
	videos,
	videoUploads,
} from "@cap/database/cloudflare/schema";
import { nanoId } from "@cap/database/helpers";
import { and, eq } from "drizzle-orm";
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
	actor: null as typeof users.$inferSelect | null,
	download: vi.fn(),
	start: vi.fn(),
	restore: vi.fn(),
	runState: vi.fn(),
	getRun: vi.fn(),
	generic: vi.fn(),
	large: vi.fn(),
	head: vi.fn(),
	writable: vi.fn(),
	createUpload: vi.fn(),
	dub: vi.fn(),
	title: "Imported video",
	provider: "s3",
}));
vi.mock("server-only", () => ({}));
vi.mock("@cap/database/cloudflare/application", () => ({
	db: () => state.database,
}));
vi.mock("@cap/database/auth/session", () => ({
	getCurrentUser: async () => state.actor,
}));
vi.mock("@cap/env", () => ({
	buildEnv: { NEXT_PUBLIC_IS_CAP: "false" },
	NODE_ENV: "test",
	serverEnv: () => ({
		CAP_VIDEOS_DEFAULT_PUBLIC: true,
		WEB_URL: "https://synthetic.example",
	}),
}));
vi.mock("@cap/utils", async (importOriginal) => ({
	...(await importOriginal<typeof import("@cap/utils")>()),
	dub: state.dub,
}));
vi.mock("@cap/web-backend", () => ({
	Storage: {
		getWritableAccessForUser: state.writable,
		createUploadTargetForUser: state.createUpload,
		getAccessForVideo: () =>
			Effect.succeed([{ provider: state.provider, headObject: state.head }]),
	},
}));
vi.mock("@/lib/server", () => ({ runPromise: Effect.runPromise }));
vi.mock("@/lib/loom-download-url", async (importOriginal) => ({
	...(await importOriginal<typeof import("@/lib/loom-download-url")>()),
	getLoomDownloadUrl: state.download,
}));
vi.mock("@/lib/loom-import-start", () => ({
	getLoomImportRunState: state.runState,
	startLoomImportWorkflow: state.start,
	restoreLoomImportStartError: state.restore,
	LOOM_IMPORT_CONFIRMATION_MESSAGE: "Confirmation required",
	LoomImportStartError: class LoomImportStartError extends Error {
		constructor(
			readonly canRetry: boolean,
			cause?: unknown,
		) {
			super("Startup failed", { cause });
		}
	},
}));
vi.mock("@/lib/video-processing", () => ({
	startVideoProcessingWorkflow: state.generic,
}));
vi.mock("@/lib/loom-file-processing", () => ({
	LOOM_FILE_SINGLE_UPLOAD_MAX_BYTES: 5 * 1024 ** 3,
	startLoomFileProcessingWorkflow: state.large,
}));
vi.mock("workflow/api", () => ({ getRun: state.getRun }));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));

import {
	createConciergeLoomFileUpload,
	downloadLoomVideo,
	getLoomImportFolders,
	importFromLoom,
	importFromLoomCsv,
	importFromLoomCsvForConcierge,
	resumeConciergeLoomFileUpload,
} from "@/actions/loom";
import { reserveConciergeImport } from "@/lib/loom-concierge";
import { importLoomVideoForOwner } from "@/lib/loom-csv-import";
import { LoomDownloadTemporaryError } from "@/lib/loom-download-url";
import { LoomImportStartError } from "@/lib/loom-import-start";

let runtime: Awaited<ReturnType<typeof createTestDatabase>>;
let owner: Awaited<ReturnType<typeof createTestOwner>>;
let requestId: string;
const loomId = "a".repeat(32);
const loomUrl = `https://www.loom.com/share/${loomId}`;
const invoke = (extra: Partial<Parameters<typeof importFromLoom>[0]> = {}) =>
	importFromLoom({ loomUrl, orgId: owner.activeOrganizationId, ...extra });
const csv = (rows = [{ rowNumber: 1, loomUrl, userEmail: owner.email }]) =>
	importFromLoomCsv({ orgId: owner.activeOrganizationId, rows });
async function seedRequest() {
	requestId = nanoId();
	await runtime.database.insert(loomMigrationRequests).values({
		id: requestId,
		organizationId: owner.activeOrganizationId,
		activeOrganizationId: owner.activeOrganizationId,
		requestedByUserId: owner.id,
		status: "in_progress",
	});
	return requestId;
}
async function seedVideo(
	options: {
		phase?: typeof videoUploads.$inferInsert.phase;
		metadata?: typeof videos.$inferInsert.metadata;
		request?: string;
		sourceId?: string;
		folderId?: typeof folders.$inferInsert.id;
		rawFileKey?: string | null;
		processingMessage?: string | null;
	} = {},
) {
	const id = nanoId() as typeof videos.$inferSelect.id;
	await runtime.database.insert(videos).values({
		id,
		ownerId: owner.id,
		orgId: owner.activeOrganizationId,
		name: "Existing import",
		source: { type: "webMP4" },
		metadata: options.metadata,
		folderId: options.folderId,
	});
	await runtime.database.insert(importedVideos).values({
		id,
		orgId: owner.activeOrganizationId,
		source: "loom",
		sourceId: options.sourceId ?? loomId,
	});
	await runtime.database.insert(videoUploads).values({
		videoId: id,
		phase: options.phase ?? "error",
		rawFileKey:
			options.rawFileKey === undefined
				? `${owner.id}/${id}/raw-upload.mp4`
				: options.rawFileKey,
		processingMessage: options.processingMessage ?? null,
		updatedAt: new Date("2026-01-01T00:00:00Z"),
	});
	if (options.request)
		await runtime.database
			.insert(loomMigrationImports)
			.values({ videoId: id, requestId: options.request });
	return id;
}
async function personalFolder(userId: typeof users.$inferSelect.id = owner.id) {
	const id = nanoId() as typeof folders.$inferSelect.id;
	await runtime.database.insert(folders).values({
		id,
		name: "Personal",
		organizationId: owner.activeOrganizationId,
		createdById: userId,
	});
	return id;
}
async function importSpace() {
	const id = nanoId() as typeof spaces.$inferSelect.id;
	await runtime.database.insert(spaces).values({
		id,
		name: "Import space",
		organizationId: owner.activeOrganizationId,
		createdById: owner.id,
	});
	return id;
}
async function createdVideo() {
	const payload = state.start.mock.calls.at(-1)?.[0] as
		| { videoId: typeof videos.$inferSelect.id }
		| undefined;
	if (!payload) throw new Error("No workflow payload");
	const [row] = await runtime.database
		.select()
		.from(videos)
		.where(eq(videos.id, payload.videoId));
	if (!row) throw new Error("Fixture missing");
	return row;
}
const fileInput = () => ({
	requestId,
	loomUrl,
	userEmail: owner.email,
	confirmedPreviousProcessingStopped: true,
});
const uploadInput = () => ({
	requestId,
	loomUrl,
	userEmail: owner.email,
	spaceName: "",
	videoTitle: "Restricted upload",
});
async function uploaded(options: Parameters<typeof seedVideo>[0] = {}) {
	await seedRequest();
	return seedVideo({ request: requestId, ...options });
}
beforeAll(async () => {
	runtime = await createTestDatabase();
	state.database = runtime.database;
}, 120_000);
afterAll(async () => runtime.dispose());
afterEach(() => {
	vi.unstubAllEnvs();
	vi.unstubAllGlobals();
});
beforeEach(async () => {
	owner = await createTestOwner(runtime.database);
	state.actor = owner;
	vi.stubEnv("CAP_RUNTIME", "cloudflare");
	vi.stubEnv("CAP_OWNER_EMAIL", owner.email);
	state.title = "Imported video";
	state.provider = "s3";
	state.download
		.mockReset()
		.mockResolvedValue("https://cdn.loom.com/video.mp4");
	state.start.mockReset().mockResolvedValue(undefined);
	state.restore.mockReset().mockResolvedValue(undefined);
	state.runState.mockReset().mockResolvedValue("inactive");
	state.getRun
		.mockReset()
		.mockReturnValue({ status: Promise.resolve("failed") });
	state.generic.mockReset().mockResolvedValue("started");
	state.large.mockReset().mockResolvedValue("started");
	state.head
		.mockReset()
		.mockReturnValue(Effect.succeed({ ContentLength: 6 * 1024 ** 3 }));
	state.writable.mockReset().mockImplementation(() =>
		Effect.succeed({
			bucketId: Option.none(),
			storageIntegrationId: Option.none(),
		}),
	);
	state.createUpload.mockReset().mockImplementation(() =>
		Effect.succeed({
			bucketId: Option.none(),
			storageIntegrationId: Option.none(),
			upload: {
				type: "presignedPut",
				url: "https://synthetic.example/upload",
			},
		}),
	);
	state.dub.mockReset();
	vi.stubGlobal(
		"fetch",
		vi.fn(async (input: RequestInfo | URL) =>
			String(input).includes("/oembed")
				? Response.json({ duration: 42, width: 1920, height: 1080 })
				: Response.json({ data: { getVideo: { name: state.title } } }),
		),
	);
});
describe("Loom import actions on D1", () => {
	it("restarts a failed recording in place without creating another video", async () => {
		const id = await seedVideo();
		expect(await invoke()).toEqual({ success: true, videoId: id });
		expect(state.start).toHaveBeenCalledWith(
			expect.objectContaining({
				videoId: id,
				reuseExistingRawUpload: true,
				userId: owner.id,
			}),
		);
		expect(
			await runtime.database
				.select()
				.from(importedVideos)
				.where(eq(importedVideos.orgId, owner.activeOrganizationId)),
		).toHaveLength(1);
	});
	it.each([true, false])(
		"restores only a definitively rejected startup: %s",
		async (canRetry) => {
			await seedVideo();
			state.start.mockRejectedValueOnce(
				new LoomImportStartError(canRetry, new Error("synthetic")),
			);
			expect((await invoke()).success).toBe(false);
			expect(state.restore).toHaveBeenCalledTimes(canRetry ? 1 : 0);
		},
	);
	it.each(["pending", "active", "unconfirmed"])(
		"holds existing %s runs",
		async (runState) => {
			await seedVideo();
			state.runState.mockResolvedValue(runState);
			expect((await invoke()).success).toBe(false);
			expect(state.start).not.toHaveBeenCalled();
		},
	);
	it.each(["", "https://attacker.example/share/abc", "javascript:alert(1)"])(
		"rejects invalid Loom URL %s",
		async (url) => {
			expect((await invoke({ loomUrl: url })).success).toBe(false);
			expect(state.download).not.toHaveBeenCalled();
		},
	);
	it("returns direct public MP4 download details", async () => {
		expect(await downloadLoomVideo(loomUrl)).toMatchObject({
			success: true,
			downloadMode: "direct-download",
			downloadUrl: "https://cdn.loom.com/video.mp4",
			durationSeconds: 42,
		});
	});
	it("returns streaming downloads for browser conversion", async () => {
		state.download.mockResolvedValue("https://cdn.loom.com/video.m3u8");
		expect(await downloadLoomVideo(loomUrl)).toMatchObject({
			success: true,
			downloadMode: "browser-conversion",
		});
	});
	it("rejects a duplicate mapping with a live recording", async () => {
		await seedVideo({ phase: "complete" });
		expect((await invoke()).success).toBe(false);
		expect(state.start).not.toHaveBeenCalled();
	});
	it.each(["a".repeat(383), "🎥".repeat(260), "Imported 🎥 video"])(
		"bounds Unicode title length without splitting characters",
		async (title) => {
			state.title = title;
			expect((await invoke()).success).toBe(true);
			expect((await createdVideo()).name).toBe(
				Array.from(title).slice(0, 255).join(""),
			);
		},
	);
	it("does not call hosted link shortening on Cloudflare", async () => {
		expect((await invoke()).success).toBe(true);
		expect(state.dub).not.toHaveBeenCalled();
	});
	it("repairs only the matching orphan among many stored source mappings", async () => {
		await runtime.database.batch(
			Array.from({ length: 50 }, (_, index) =>
				runtime.database.insert(importedVideos).values({
					id: nanoId() as typeof videos.$inferSelect.id,
					orgId: owner.activeOrganizationId,
					source: "loom",
					sourceId: index === 0 ? loomId : `other-source-${index}`,
				}),
			),
		);
		expect((await invoke()).success).toBe(true);
		const rows = await runtime.database
			.select()
			.from(importedVideos)
			.where(
				and(
					eq(importedVideos.orgId, owner.activeOrganizationId),
					eq(importedVideos.sourceId, loomId),
				),
			);
		expect(rows).toHaveLength(1);
		expect(rows[0]?.id).toBe((await createdVideo()).id);
		expect(
			await runtime.database
				.select()
				.from(importedVideos)
				.where(eq(importedVideos.orgId, owner.activeOrganizationId)),
		).toHaveLength(50);
	});
	it("allows only one concurrent publication for the same source", async () => {
		const results = await Promise.allSettled(
			Array.from({ length: 3 }, () => invoke()),
		);
		expect(
			results.filter(
				(result) => result.status === "fulfilled" && result.value.success,
			),
		).toHaveLength(1);
		expect(state.start).toHaveBeenCalledTimes(1);
	});
	it("uses current private visibility defaults", async () => {
		await runtime.database
			.update(organizations)
			.set({ defaultVideoVisibility: "private" })
			.where(eq(organizations.id, owner.activeOrganizationId));
		await invoke();
		expect((await createdVideo()).public).toBe(false);
	});
	it("publishes a personal-folder destination", async () => {
		const folderId = await personalFolder();
		expect((await invoke({ folderId })).success).toBe(true);
		expect((await createdVideo()).folderId).toBe(folderId);
	});
	it.each(["space", "organization"])(
		"publishes a %s destination and its sharing record together",
		async (scope) => {
			const spaceId =
				scope === "space" ? await importSpace() : owner.activeOrganizationId;
			expect((await invoke({ spaceId })).success).toBe(true);
			const row = await createdVideo();
			expect(row.folderId).toBeNull();
			if (scope === "space")
				expect(
					await runtime.database
						.select()
						.from(spaceVideos)
						.where(eq(spaceVideos.videoId, row.id)),
				).toHaveLength(1);
		},
	);
	it("rejects missing and foreign personal folders before fetching", async () => {
		expect(
			(await invoke({ folderId: nanoId() as typeof folders.$inferSelect.id }))
				.success,
		).toBe(false);
		const other = await createTestOwner(runtime.database);
		const folderId = await personalFolder(other.id);
		expect((await invoke({ folderId })).success).toBe(false);
		expect(state.download).not.toHaveBeenCalled();
	});
	it("rejects a space from another organization", async () => {
		const other = await createTestOwner(runtime.database);
		const id = nanoId() as typeof spaces.$inferSelect.id;
		await runtime.database.insert(spaces).values({
			id,
			name: "Foreign",
			organizationId: other.activeOrganizationId,
			createdById: other.id,
		});
		await expect(invoke({ spaceId: id })).rejects.toThrow();
		expect(state.start).not.toHaveBeenCalled();
	});
	it("rechecks destination revocation after storage preparation", async () => {
		const folderId = await personalFolder();
		state.writable.mockImplementationOnce(() =>
			Effect.promise(async () => {
				await runtime.database.delete(folders).where(eq(folders.id, folderId));
				return { bucketId: Option.none(), storageIntegrationId: Option.none() };
			}),
		);
		await expect(invoke({ folderId })).rejects.toThrow("Folder not found");
		expect(state.start).not.toHaveBeenCalled();
	});
	it("lists only the signed-in owner's personal folders", async () => {
		const own = await personalFolder();
		const other = await createTestOwner(runtime.database);
		await personalFolder(other.id);
		expect(
			await getLoomImportFolders({ orgId: owner.activeOrganizationId }),
		).toMatchObject([{ id: own }]);
	});
	it("denies a member and a signed-out user bulk provisioning", async () => {
		const other = await createTestOwner(runtime.database);
		await runtime.database.insert(organizationMembers).values({
			id: nanoId(),
			userId: other.id,
			organizationId: owner.activeOrganizationId,
			role: "member",
		});
		state.actor = other;
		expect((await csv()).success).toBe(false);
		state.actor = null;
		expect((await csv()).success).toBe(false);
		expect(state.start).not.toHaveBeenCalled();
	});
	it("provisions missing CSV users and starts their imports", async () => {
		const email = `${nanoId()}@example.com`;
		expect(
			await csv([{ rowNumber: 1, loomUrl, userEmail: email }]),
		).toMatchObject({ importedCount: 1, failedCount: 0 });
		const [user] = await runtime.database
			.select()
			.from(users)
			.where(eq(users.email, email));
		expect(user).toBeDefined();
		expect((await createdVideo()).ownerId).toBe(user?.id);
	});
	it("records temporary Loom failures as retryable CSV errors", async () => {
		state.download.mockRejectedValueOnce(
			new LoomDownloadTemporaryError(60_000),
		);
		expect(await csv()).toMatchObject({
			importedCount: 0,
			failedCount: 1,
			results: [{ errorCode: "loom_temporarily_unavailable" }],
		});
	});
	it("enforces the 500-row CSV bound before writes", async () => {
		const rows = Array.from({ length: 501 }, (_, index) => ({
			rowNumber: index + 1,
			loomUrl,
			userEmail: owner.email,
		}));
		expect((await csv(rows)).success).toBe(false);
		expect(state.start).not.toHaveBeenCalled();
	});
	it("creates a requested CSV space once and adds owner and video records", async () => {
		const result = await importFromLoomCsv({
			orgId: owner.activeOrganizationId,
			rows: [
				{
					rowNumber: 1,
					loomUrl,
					userEmail: owner.email,
					spaceName: "  Team   demos ",
				},
			],
		});
		expect(result.importedCount).toBe(1);
		const [space] = await runtime.database
			.select()
			.from(spaces)
			.where(eq(spaces.organizationId, owner.activeOrganizationId));
		expect(space?.name).toBe("Team demos");
		expect(
			await runtime.database
				.select()
				.from(spaceVideos)
				.where(eq(spaceVideos.videoId, (await createdVideo()).id)),
		).toHaveLength(1);
		expect(
			await runtime.database
				.select()
				.from(spaceMembers)
				.where(
					eq(spaceMembers.spaceId, space?.id as typeof spaces.$inferSelect.id),
				),
		).toHaveLength(1);
	});
	it("records a restarted concierge import once under its lease", async () => {
		await seedRequest();
		const id = await seedVideo();
		const result = await importFromLoomCsvForConcierge({
			requestId,
			rows: [{ rowNumber: 1, loomUrl, userEmail: owner.email }],
		});
		expect(result).toMatchObject({ ok: true, value: { importedCount: 1 } });
		expect(
			await runtime.database
				.select()
				.from(loomMigrationImports)
				.where(eq(loomMigrationImports.videoId, id)),
		).toMatchObject([{ requestId }]);
		const [request] = await runtime.database
			.select()
			.from(loomMigrationRequests)
			.where(eq(loomMigrationRequests.id, requestId));
		expect(request?.queuedVideoCount).toBe(1);
	});
	it("does not count a concierge retry twice", async () => {
		await seedRequest();
		await seedVideo({ request: requestId });
		const result = await importFromLoomCsvForConcierge({
			requestId,
			rows: [{ rowNumber: 1, loomUrl, userEmail: owner.email }],
		});
		expect(result).toMatchObject({ ok: true, value: { importedCount: 1 } });
		const [request] = await runtime.database
			.select()
			.from(loomMigrationRequests)
			.where(eq(loomMigrationRequests.id, requestId));
		expect(request?.queuedVideoCount).toBe(0);
	});
	it("does not restart when a concierge lease has expired", async () => {
		await seedRequest();
		await seedVideo();
		const token = await reserveConciergeImport(requestId, owner.id);
		await runtime.database
			.update(loomMigrationRequests)
			.set({ activeImportLeaseUntil: new Date(0) })
			.where(eq(loomMigrationRequests.id, requestId));
		await expect(
			importLoomVideoForOwner({
				loomUrl,
				orgId: owner.activeOrganizationId,
				ownerId: owner.id,
				migrationRequestId: requestId,
				migrationLeaseToken: token,
			}),
		).rejects.toThrow("expired");
		expect(state.start).not.toHaveBeenCalled();
	});
	it("refuses a recording already mapped to another request", async () => {
		await seedRequest();
		const otherRequest = requestId;
		await runtime.database
			.update(loomMigrationRequests)
			.set({ activeOrganizationId: null })
			.where(eq(loomMigrationRequests.id, otherRequest));
		await seedRequest();
		await seedVideo({ request: otherRequest });
		expect(
			await importFromLoomCsvForConcierge({
				requestId,
				rows: [{ rowNumber: 1, loomUrl, userEmail: owner.email }],
			}),
		).toMatchObject({ ok: true, value: { failedCount: 1 } });
		expect(state.start).not.toHaveBeenCalled();
	});
	it("creates and resumes a restricted upload under one recording", async () => {
		await seedRequest();
		const result = await createConciergeLoomFileUpload(uploadInput());
		expect(result.ok).toBe(true);
		if (!result.ok) throw new Error(result.error);
		expect(
			await runtime.database
				.select()
				.from(loomMigrationImports)
				.where(eq(loomMigrationImports.videoId, result.value.videoId)),
		).toHaveLength(1);
		expect(await resumeConciergeLoomFileUpload(fileInput())).toMatchObject({
			ok: true,
			value: { status: "started" },
		});
		expect(state.large).toHaveBeenCalledTimes(1);
	});
});
describe("resuming uploaded concierge recordings on D1", () => {
	it("requires explicit stopped-processing confirmation", async () => {
		await uploaded();
		expect(
			await resumeConciergeLoomFileUpload({
				...fileInput(),
				confirmedPreviousProcessingStopped: false,
			}),
		).toMatchObject({ ok: false });
		expect(state.head).not.toHaveBeenCalled();
	});
	it.each(["running", "pending", "unknown"])(
		"holds %s previous workflows",
		async (status) => {
			await uploaded({
				metadata: { loomImportRun: { runId: "old-run", dispatch: "accepted" } },
			});
			state.getRun.mockImplementation(() => ({
				status:
					status === "unknown"
						? Promise.reject(new Error("unavailable"))
						: Promise.resolve(status),
			}));
			expect(await resumeConciergeLoomFileUpload(fileInput())).toMatchObject({
				ok: false,
			});
			expect(state.large).not.toHaveBeenCalled();
		},
	);
	it("resumes an explicitly rejected queue without querying it", async () => {
		await uploaded({
			metadata: { loomImportRun: { runId: "old-run", dispatch: "rejected" } },
		});
		expect(await resumeConciergeLoomFileUpload(fileInput())).toMatchObject({
			ok: true,
		});
		expect(state.getRun).not.toHaveBeenCalled();
	});
	it.each([1024, 5 * 1024 ** 3])(
		"keeps %s-byte files on the normal processing path",
		async (size) => {
			await uploaded();
			state.head.mockReturnValue(Effect.succeed({ ContentLength: size }));
			expect(await resumeConciergeLoomFileUpload(fileInput())).toMatchObject({
				ok: true,
			});
			expect(state.generic).toHaveBeenCalledTimes(1);
			expect(state.large).not.toHaveBeenCalled();
		},
	);
	it("keeps non-S3 storage on its existing processing path", async () => {
		await uploaded();
		state.provider = "google-drive";
		expect(await resumeConciergeLoomFileUpload(fileInput())).toMatchObject({
			ok: true,
		});
		expect(state.generic).toHaveBeenCalledTimes(1);
	});
	it.each(["processing", "complete"] as const)(
		"rejects an upload already %s",
		async (phase) => {
			await uploaded({ phase });
			expect(await resumeConciergeLoomFileUpload(fileInput())).toMatchObject({
				ok: false,
			});
			expect(state.head).not.toHaveBeenCalled();
		},
	);
	it.each([0, 11 * 1024 ** 3])(
		"rejects an invalid uploaded size %s",
		async (size) => {
			await uploaded();
			state.head.mockReturnValue(Effect.succeed({ ContentLength: size }));
			expect(await resumeConciergeLoomFileUpload(fileInput())).toMatchObject({
				ok: false,
			});
			expect(state.generic).not.toHaveBeenCalled();
			expect(state.large).not.toHaveBeenCalled();
		},
	);
	it("stops if owner identity no longer matches the request", async () => {
		const id = await uploaded();
		const other = await createTestOwner(runtime.database);
		await runtime.database
			.update(videos)
			.set({ ownerId: other.id })
			.where(eq(videos.id, id));
		expect(await resumeConciergeLoomFileUpload(fileInput())).toMatchObject({
			ok: false,
		});
		expect(state.large).not.toHaveBeenCalled();
	});
	it("rejects missing stored uploads", async () => {
		await uploaded();
		state.head.mockReturnValue(Effect.fail(new Error("not found")));
		expect(await resumeConciergeLoomFileUpload(fileInput())).toMatchObject({
			ok: false,
		});
		expect(state.large).not.toHaveBeenCalled();
	});
	it("requires verified operator identity before reading recordings", async () => {
		await uploaded();
		state.actor = null;
		expect(await resumeConciergeLoomFileUpload(fileInput())).toMatchObject({
			ok: false,
		});
		expect(state.head).not.toHaveBeenCalled();
	});
});
