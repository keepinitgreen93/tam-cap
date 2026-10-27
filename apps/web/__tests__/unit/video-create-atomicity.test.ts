import { Folder, Organisation, User, Video } from "@cap/web-domain";
import { Effect, Option } from "effect";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
	type CreateVideoInput,
	VideosRepo,
} from "../../../../packages/web-backend/src/Videos/VideosRepo";

type Row = Record<string, unknown>;
type Predicate = (row: Row) => boolean;
type Store = {
	videos: Map<string, Row>;
	uploads: Map<string, Row>;
	folders: Map<string, Row>;
};

const mocks = vi.hoisted(() => ({
	store: {
		videos: new Map<string, Row>(),
		uploads: new Map<string, Row>(),
		folders: new Map<string, Row>(),
	} as Store,
	rejectUpload: false,
	transactionCalls: 0,
	cloudflareDb: null as (() => unknown) | null,
	currentUser: vi.fn(),
	organizationAccess: vi.fn(),
	getWritableAccessForUser: vi.fn(),
	createUploadTargetForUser: vi.fn(),
	createUploadTargetForVideo: vi.fn(),
	revalidatePath: vi.fn(),
}));

vi.mock("@cap/database", async () => {
	const { databaseRevision, snapshotGuard } = await import(
		"../../../../packages/database/cloudflare/concurrency-schema"
	);
	const { SQLiteSyncDialect } = await import("drizzle-orm/sqlite-core");
	type Table =
		| { name?: string }
		| typeof databaseRevision
		| typeof snapshotGuard;
	type Statement = { table: Table; values: Row | Row[] };
	type Client = {
		insert: (table: Table) => {
			values: (values: Row | Row[]) => Promise<void> & Statement;
		};
		delete: (table: Table) => { where: () => Statement };
		select: () => {
			from: (table: Table) => {
				where: (
					predicate: Predicate,
				) => Promise<Row[]> & { limit: () => Promise<Row[]> };
			};
		};
		selectDistinct: () => never;
		query: Record<string, never>;
		batch: (statements: Statement[]) => Promise<unknown[]>;
		transaction: (run: (tx: Client) => Promise<unknown>) => Promise<unknown>;
	};
	const revision = () => mocks.store.videos.size + mocks.store.uploads.size;
	function makeClient(store: Store, lazy = false): Client {
		const write = (table: Table, value: Row | Row[]) => {
			if (table === snapshotGuard) return;
			if ("name" in table && table.name === "upload" && mocks.rejectUpload)
				throw new Error("Injected upload insert failure");
			const rows =
				"name" in table && table.name === "video"
					? store.videos
					: store.uploads;
			for (const row of Array.isArray(value) ? value : [value])
				rows.set(
					String(
						"name" in table && table.name === "video" ? row.id : row.videoId,
					),
					{ ...row },
				);
		};
		const client: Client = {
			insert: (table: Table) => ({
				values: (values: Row | Row[]) =>
					Object.assign(
						lazy
							? Promise.resolve()
							: Promise.resolve().then(() => write(table, values)),
						{ table, values },
					),
			}),
			delete: (table: Table) => ({ where: () => ({ table, values: {} }) }),
			select: () => ({
				from: (table: Table) => ({
					where: (predicate: Predicate) => {
						const read = () => {
							if (table === databaseRevision) return [{ revision: revision() }];
							if ("name" in table && table.name === "organization")
								return [
									{
										id: "fixture-org",
										ownerId: "fixture-user",
										tombstoneAt: null,
									},
								];
							if ("name" in table && table.name === "membership") return [];
							const rows =
								"name" in table && table.name === "folder"
									? store.folders
									: store.videos;
							return [...rows.values()].filter(predicate);
						};
						return Object.assign(Promise.resolve().then(read), {
							limit: async () => read(),
						});
					},
				}),
			}),
			selectDistinct: () => {
				throw new Error("Unexpected distinct selection");
			},
			query: {},
			batch: async (statements: Statement[]) => {
				mocks.transactionCalls++;
				const guard = statements.find(
					(statement) =>
						statement.table === snapshotGuard &&
						!Array.isArray(statement.values) &&
						statement.values.valid,
				);
				if (guard && !Array.isArray(guard.values)) {
					const expected = new SQLiteSyncDialect().sqlToQuery(
						guard.values.valid as import("drizzle-orm").SQL,
					).params[0];
					if (expected !== revision())
						throw new Error("CHECK constraint failed: cap_d1_snapshot_guard");
				}
				const candidate = {
					videos: new Map(store.videos),
					uploads: new Map(store.uploads),
					folders: new Map(store.folders),
				};
				const writer = makeClient(candidate);
				for (const statement of statements)
					if (statement.table !== snapshotGuard)
						await writer.insert(statement.table).values(statement.values);
				mocks.store = candidate;
				return [];
			},
			transaction: async (run: (tx: Client) => Promise<unknown>) => {
				mocks.transactionCalls++;
				const candidate = {
					videos: new Map(store.videos),
					uploads: new Map(store.uploads),
					folders: new Map(store.folders),
				};
				const result = await run(makeClient(candidate));
				mocks.store = candidate;
				return result;
			},
		};
		return client;
	}
	mocks.cloudflareDb = () => makeClient(mocks.store, true);
	return { db: () => makeClient(mocks.store) };
});
vi.mock("@cap/database/cloudflare/application", async () => {
	await import("@cap/database");
	return {
		db: () => {
			if (!mocks.cloudflareDb) throw new Error("Missing D1 fixture");
			return mocks.cloudflareDb();
		},
	};
});
vi.mock("@cap/database/cloudflare/schema", async () => ({
	...(await import("@cap/database/schema")),
	videoProcessingJobs: {
		name: "job",
		videoId: "videoId",
		errorCode: "errorCode",
	},
	organizations: {
		name: "organization",
		id: "id",
		ownerId: "ownerId",
		tombstoneAt: "tombstoneAt",
	},
	organizationMembers: {
		name: "membership",
		userId: "userId",
		organizationId: "organizationId",
	},
}));

vi.mock("@cap/database/auth/session", () => ({
	getCurrentUser: mocks.currentUser,
}));
vi.mock("@cap/database/helpers", () => ({ nanoId: () => "fixture-video" }));
vi.mock("@cap/database/schema", () => ({
	videos: { name: "video", id: "id" },
	folders: {
		name: "folder",
		id: "id",
		organizationId: "organizationId",
		createdById: "createdById",
		spaceId: "spaceId",
	},
	videoUploads: { name: "upload", videoId: "videoId" },
}));
// The real lookup reads `organizations`, which this transaction mock does not
// model; visibility is not what these tests are about.
vi.mock("@cap/database/video-sharing-default", () => ({
	getNewVideoPublic: async () => true,
}));
vi.mock("@cap/env", () => ({
	serverEnv: () => ({ CAP_VIDEOS_DEFAULT_PUBLIC: true }),
}));
vi.mock("@cap/utils", () => ({ userIsPro: () => true }));
vi.mock("@cap/web-backend", async () => {
	const { Context, Layer } = await import("effect");
	return {
		makeCurrentUserLayer: () => Layer.empty,
		Videos: Context.GenericTag("FixtureVideos"),
		Storage: {
			getWritableAccessForUser: mocks.getWritableAccessForUser,
			createUploadTargetForUser: mocks.createUploadTargetForUser,
			createUploadTargetForVideo: mocks.createUploadTargetForVideo,
		},
	};
});
vi.mock("@/actions/organization/authorization", () => ({
	requireOrganizationAccess: mocks.organizationAccess,
}));
vi.mock("@/lib/server", async () => ({
	runPromise: (await import("effect")).Effect.runPromise,
}));
vi.mock("next/cache", () => ({ revalidatePath: mocks.revalidatePath }));
vi.mock("drizzle-orm", async (importOriginal) => {
	const actual = await importOriginal<typeof import("drizzle-orm")>();
	return {
		...actual,
		eq: (field: string | Parameters<typeof actual.eq>[0], value: unknown) =>
			typeof field === "string"
				? (row: Row) => row[field] === value
				: actual.eq(field, value),
		and: (
			...predicates: Array<Predicate | import("drizzle-orm").SQL | undefined>
		) =>
			predicates.every((predicate) => typeof predicate === "function")
				? (row: Row) =>
						(predicates as Predicate[]).every((predicate) => predicate(row))
				: actual.and(...(predicates as import("drizzle-orm").SQL[])),
		isNull: (field: string | Parameters<typeof actual.isNull>[0]) =>
			typeof field === "string"
				? (row: Row) => row[field] === null
				: actual.isNull(field),
	};
});

import { createVideoForServerProcessing } from "@/actions/video/create-for-processing";
import { createVideoAndGetUploadUrl } from "@/actions/video/upload";

const orgId = Organisation.OrganisationId.make("fixture-org");
const uploadTarget = {
	type: "s3Post" as const,
	url: "https://uploads.example.com/fixture",
	fields: {},
};
const repoCreateData: CreateVideoInput = {
	ownerId: User.UserId.make("fixture-user"),
	orgId,
	name: "Fixture recording",
	public: true,
	source: { type: "webMP4" },
	bucketId: Option.none(),
	storageIntegrationId: Option.none(),
	folderId: Option.none(),
	metadata: Option.none(),
	transcriptionStatus: Option.none(),
	width: Option.none(),
	height: Option.none(),
	duration: Option.none(),
};

function createRepoVideo(initialUpload?: {
	mode: "singlepart";
	total?: number;
}) {
	return Effect.runPromise(
		Effect.flatMap(VideosRepo, (repo) =>
			repo.create(repoCreateData, {
				id: Video.VideoId.make("fixture-video"),
				initialUpload,
			}),
		).pipe(Effect.provide(VideosRepo.Default)),
	);
}

beforeEach(() => {
	mocks.store = { videos: new Map(), uploads: new Map(), folders: new Map() };
	mocks.rejectUpload = false;
	mocks.transactionCalls = 0;
	mocks.currentUser.mockResolvedValue({ id: "fixture-user" });
	mocks.organizationAccess.mockResolvedValue(undefined);
	mocks.getWritableAccessForUser.mockReturnValue(
		Effect.succeed({
			bucketId: Option.none(),
			storageIntegrationId: Option.none(),
		}),
	);
	mocks.createUploadTargetForUser.mockReturnValue(
		Effect.succeed({
			bucketId: Option.none(),
			storageIntegrationId: Option.none(),
			upload: uploadTarget,
		}),
	);
	mocks.createUploadTargetForVideo.mockReturnValue(
		Effect.succeed(uploadTarget),
	);
	vi.spyOn(console, "error").mockImplementation(() => undefined);
});

function expectCommittedPair() {
	expect(mocks.transactionCalls).toBe(1);
	expect(mocks.store.videos.size).toBe(1);
	expect(mocks.store.uploads.size).toBe(1);
	const video = [...mocks.store.videos.values()][0];
	const upload = [...mocks.store.uploads.values()][0];
	expect(upload?.videoId).toBe(video?.id);
	expect(mocks.revalidatePath.mock.calls.map(([path]) => path)).toEqual([
		"/dashboard/caps",
		"/dashboard/folder",
		"/dashboard/spaces",
	]);
}

describe("video creation with upload progress", () => {
	it("does not sign or change a recording owned by another user", async () => {
		const videoId = Video.VideoId.make("fixture-video");
		const existingVideo = { id: videoId, ownerId: "other-fixture-user" };
		mocks.store.videos.set(videoId, existingVideo);
		await expect(
			createVideoAndGetUploadUrl({
				orgId,
				videoId,
				supportsUploadProgress: true,
			}),
		).rejects.toThrow("Forbidden");
		expect(mocks.store.videos.get(videoId)).toEqual(existingVideo);
		expect(mocks.store.uploads.size).toBe(0);
		expect(mocks.transactionCalls).toBe(0);
		expect(mocks.createUploadTargetForVideo).not.toHaveBeenCalled();
		expect(mocks.revalidatePath).not.toHaveBeenCalled();
	});

	it("rolls back a recording when the progress insert fails", async () => {
		mocks.rejectUpload = true;
		await expect(
			createVideoAndGetUploadUrl({ orgId, supportsUploadProgress: true }),
		).rejects.toThrow("Injected upload insert failure");
		expect(mocks.transactionCalls).toBe(1);
		expect(mocks.store.videos.size).toBe(0);
		expect(mocks.store.uploads.size).toBe(0);
		expect(mocks.revalidatePath).not.toHaveBeenCalled();
	});

	it("commits a recording and its progress row together", async () => {
		const result = await createVideoAndGetUploadUrl({
			orgId,
			supportsUploadProgress: true,
		});
		expect(result.id).toBe("fixture-video");
		expectCommittedPair();
	});

	it("creates only a recording when progress is disabled", async () => {
		const result = await createVideoAndGetUploadUrl({ orgId });
		expect(result.id).toBe("fixture-video");
		expect(mocks.transactionCalls).toBe(1);
		expect(mocks.store.videos.size).toBe(1);
		expect(mocks.store.uploads.size).toBe(0);
		expect(mocks.revalidatePath).toHaveBeenCalledTimes(3);
	});
});

describe("video creation for server processing", () => {
	it("rolls back a video when the progress insert fails", async () => {
		mocks.rejectUpload = true;
		await expect(createVideoForServerProcessing({ orgId })).rejects.toThrow(
			"Injected upload insert failure",
		);
		expect(mocks.transactionCalls).toBe(1);
		expect(mocks.store.videos.size).toBe(0);
		expect(mocks.store.uploads.size).toBe(0);
		expect(mocks.revalidatePath).not.toHaveBeenCalled();
	});

	it("commits the video and its raw upload metadata together", async () => {
		const result = await createVideoForServerProcessing({ orgId });
		expect(result.id).toBe("fixture-video");
		expectCommittedPair();
		const upload = [...mocks.store.uploads.values()][0];
		expect(upload).toMatchObject({
			mode: "singlepart",
			phase: "uploading",
			processingProgress: 0,
			rawFileKey: "fixture-user/fixture-video/raw-upload.mp4",
		});
	});
});

describe("VideosRepo.create", () => {
	it("commits a video and optional upload row together", async () => {
		const id = await createRepoVideo({ mode: "singlepart", total: 123 });
		expect(id).toBe("fixture-video");
		expect(mocks.transactionCalls).toBe(1);
		expect(mocks.store.videos.get(id)).toMatchObject({
			id,
			ownerId: "fixture-user",
			orgId,
		});
		expect(mocks.store.uploads.get(id)).toMatchObject({
			videoId: id,
			mode: "singlepart",
			total: 123,
		});
		expect(mocks.revalidatePath).not.toHaveBeenCalled();
	});

	it("rolls back a video if its optional upload insert fails", async () => {
		mocks.rejectUpload = true;
		await expect(createRepoVideo({ mode: "singlepart" })).rejects.toThrow(
			"Injected upload insert failure",
		);
		expect(mocks.transactionCalls).toBe(1);
		expect(mocks.store.videos.size).toBe(0);
		expect(mocks.store.uploads.size).toBe(0);
	});

	it("commits a video without an upload row when progress is disabled", async () => {
		const id = await createRepoVideo();
		expect(id).toBe("fixture-video");
		expect(mocks.transactionCalls).toBe(1);
		expect(mocks.store.videos.get(id)?.id).toBe(id);
		expect(mocks.store.uploads.size).toBe(0);
	});
});

describe.each([
	{
		name: "video file import",
		create: (folderId?: Folder.FolderId) =>
			createVideoForServerProcessing({ orgId, folderId }),
	},
	{
		name: "image file import",
		create: (folderId?: Folder.FolderId) =>
			createVideoAndGetUploadUrl({
				orgId,
				folderId,
				isUpload: true,
				isScreenshot: true,
			}),
	},
])("$name destination", ({ create }) => {
	const folderId = Folder.FolderId.make("fixture-folder");
	const personalFolder = {
		id: folderId,
		organizationId: orgId,
		createdById: "fixture-user",
		spaceId: null,
	};

	it.each([
		{ name: "missing folder", folder: undefined },
		{
			name: "a different folder",
			folder: { ...personalFolder, id: "different-folder" },
		},
		{
			name: "another user's personal folder",
			folder: { ...personalFolder, createdById: "other-user" },
		},
		{
			name: "own folder in another organization",
			folder: { ...personalFolder, organizationId: "other-org" },
		},
		{
			name: "space folder",
			folder: { ...personalFolder, spaceId: "fixture-space" },
		},
		{
			name: "organization folder",
			folder: { ...personalFolder, spaceId: orgId },
		},
	])(
		"rejects $name before signing or creating an upload",
		async ({ folder }) => {
			if (folder) mocks.store.folders.set(folderId, folder);

			await expect(create(folderId)).rejects.toThrow("Folder not found");

			expect(mocks.createUploadTargetForUser).not.toHaveBeenCalled();
			expect(mocks.store.videos.size).toBe(0);
			expect(mocks.store.uploads.size).toBe(0);
			expect(mocks.transactionCalls).toBe(0);
			expect(mocks.revalidatePath).not.toHaveBeenCalled();
		},
	);

	it("accepts an owned personal folder in the selected organization", async () => {
		mocks.store.folders.set(folderId, personalFolder);

		const result = await create(folderId);

		expect(mocks.store.videos.get(result.id)?.folderId).toBe(folderId);
		expect(mocks.getWritableAccessForUser).toHaveBeenCalledOnce();
		expect(mocks.createUploadTargetForVideo).toHaveBeenCalledOnce();
	});

	it("accepts an import without a folder", async () => {
		const result = await create();

		expect(mocks.store.videos.get(result.id)?.folderId).toBeUndefined();
		expect(mocks.getWritableAccessForUser).toHaveBeenCalledOnce();
		expect(mocks.createUploadTargetForVideo).toHaveBeenCalledOnce();
	});
});
