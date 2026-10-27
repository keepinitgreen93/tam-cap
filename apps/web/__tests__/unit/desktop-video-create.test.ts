import { getCurrentUser } from "@cap/database/auth/session";
import {
	CurrentUser,
	Policy,
	Storage as StorageDomain,
	Video,
} from "@cap/web-domain";
import { QueryPromise } from "drizzle-orm/query-promise";
import { Effect, Option } from "effect";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	databaseRevision,
	snapshotGuard,
} from "../../../../packages/database/cloudflare/concurrency-schema";

const deletion = vi.hoisted(() => ({
	deleteVideo: vi.fn(),
	principal: vi.fn(),
}));
const defaultSharing = vi.hoisted(() => ({
	getNewVideoPublic: vi.fn(),
}));

const schema = {
	organizations: { table: "organizations" },
	organizationMembers: { table: "organizationMembers" },
	users: { table: "users" },
	videos: { table: "videos" },
	videoUploads: { table: "videoUploads" },
	importedVideos: { table: "importedVideos" },
	authApiKeys: { table: "authApiKeys" },
	videoProcessingJobs: { table: "videoProcessingJobs" },
	s3Buckets: { table: "s3Buckets" },
	storageIntegrations: { table: "storageIntegrations" },
};

for (const [name, table] of Object.entries(schema))
	Object.assign(
		table,
		Object.fromEntries(
			[
				"id",
				"videoId",
				"userId",
				"ownerId",
				"organizationId",
				"orgId",
				"tombstoneAt",
				"errorCode",
				"source",
			].map((field) => [field, `${name}.${field}`]),
		),
	);

const mockDb = {
	select: vi.fn(),
	from: vi.fn(),
	innerJoin: vi.fn(),
	leftJoin: vi.fn(),
	insert: vi.fn(),
	values: vi.fn(),
	update: vi.fn(),
	set: vi.fn(),
	where: vi.fn(),
	delete: vi.fn(),
	for: vi.fn(),
	limit: vi.fn(),
	transaction: vi.fn(),
};

vi.mock("@cap/database", () => ({
	db: () => mockDb,
}));
vi.mock("@cap/database/video-sharing-default", () => defaultSharing);

vi.mock("@cap/database/auth/session", () => ({
	getCurrentUser: vi.fn(),
}));

vi.mock("@cap/database/auth/auth-options", () => ({
	getServerSession: vi.fn(),
}));

vi.mock("@cap/database/schema", () => schema);
vi.mock("@cap/database/cloudflare/schema", () => schema);
vi.mock("@cap/database/cloudflare/application", () => ({ db: () => d1Mock }));

vi.mock("@cap/database/emails/config", () => ({
	sendEmail: vi.fn(),
}));

vi.mock("@cap/database/emails/first-shareable-link", () => ({
	FirstShareableLink: () => null,
}));

vi.mock("@cap/env", () => ({
	serverEnv: () => ({
		CAP_VIDEOS_DEFAULT_PUBLIC: true,
		WEB_URL: "https://cap.test",
	}),
	buildEnv: {
		NEXT_PUBLIC_IS_CAP: true,
		NEXT_PUBLIC_WEB_URL: "https://cap.test",
	},
}));

vi.mock("@cap/utils", () => ({
	userIsPro: vi.fn(() => true),
}));

vi.mock("@cap/web-backend", async () => {
	const { Effect } = await import("effect");
	const { makeCurrentUserLayer } = await import("@cap/web-backend/src/Auth");
	class Videos extends Effect.Service<Videos>()("Videos", {
		sync: () => ({ delete: deletion.deleteVideo }),
	}) {}
	return {
		makeCurrentUserLayer,
		Videos,
		Storage: {
			getOrganizationWritableAccess: vi.fn(),
			getS3WritableAccessForUser: vi.fn(),
		},
	};
});

vi.mock("@/lib/server", async () => {
	const { Effect } = await import("effect");
	const { Videos } = await import("@cap/web-backend");
	return {
		runPromise: vi.fn(async (value: unknown) =>
			Effect.isEffect(value)
				? Effect.runPromise(
						(
							value as Effect.Effect<
								unknown,
								unknown,
								InstanceType<typeof Videos>
							>
						).pipe(Effect.provide(Videos.Default)),
					)
				: value,
		),
	};
});

vi.mock("@/lib/video-storage", () => ({
	decodeStorageVideo: vi.fn(() => null),
}));

vi.mock("@/lib/google-drive-storage-quota", () => ({
	invalidateGoogleDriveStorageQuotaCache: vi.fn(),
}));

vi.mock("@/lib/server-analytics", () => ({
	trackServerEvent: vi.fn(),
}));

// The live-transcription stack drags in the whole workflow graph
// (server-only modules included); these tests only care that create works.
vi.mock("@/lib/live-transcribe", () => ({
	maybeStartLiveTranscription: vi.fn(async () => "skipped"),
}));

vi.mock("drizzle-orm", () => ({
	sql: (strings: TemplateStringsArray, ...values: unknown[]) => ({
		strings,
		values,
	}),
	isNull: (field: unknown) => ({ field, nullCheck: true }),
	and: vi.fn((...args: unknown[]) => args),
	eq: vi.fn((field: unknown, value: unknown) => ({ field, value })),
	count: vi.fn(() => "count()"),
	lte: vi.fn(() => "lte()"),
}));

const mockGetCurrentUser = getCurrentUser as ReturnType<typeof vi.fn>;
const { Storage } = await import("@cap/web-backend");
const { invalidateGoogleDriveStorageQuotaCache } = await import(
	"@/lib/google-drive-storage-quota"
);
const { maybeStartLiveTranscription } = await import("@/lib/live-transcribe");
const { trackServerEvent } = await import("@/lib/server-analytics");

type D1Row = Record<string, unknown>;
type D1Mutation = {
	table: unknown;
	operation: "insert" | "update" | "delete";
	values?: D1Row;
	condition?: unknown;
};
let d1Revision = 0;
let d1Planning = false;
const d1Rows = new Map<unknown, D1Row[]>();
const fieldName = (field: unknown) =>
	typeof field === "string" ? field.split(".").at(-1) : undefined;
function matchesD1(row: D1Row, condition: unknown): boolean {
	if (Array.isArray(condition))
		return condition.every((part) => matchesD1(row, part));
	if (!condition || typeof condition !== "object" || !("field" in condition))
		return true;
	const name = fieldName(condition.field);
	if (!name) return true;
	return "nullCheck" in condition
		? row[name] == null
		: "value" in condition
			? row[name] === condition.value
			: true;
}
async function fixtureUser(): Promise<D1Row> {
	const user: unknown = await mockGetCurrentUser.mock.results.at(-1)?.value;
	return user && typeof user === "object" ? (user as D1Row) : {};
}
class D1Selection extends QueryPromise<D1Row[]> {
	private table: unknown;
	private condition: unknown;
	private maximum: number | undefined;
	private joins: Array<{ kind: "innerJoin" | "leftJoin"; args: unknown[] }> =
		[];
	constructor(private fields?: unknown) {
		super();
	}
	from(table: unknown) {
		this.table = table;
		return this;
	}
	where(condition: unknown) {
		this.condition = condition;
		return this;
	}
	limit(maximum: number) {
		this.maximum = maximum;
		return this;
	}
	innerJoin(...args: unknown[]) {
		this.joins.push({ kind: "innerJoin", args });
		return this;
	}
	leftJoin(...args: unknown[]) {
		this.joins.push({ kind: "leftJoin", args });
		return this;
	}
	orderBy() {
		return this;
	}
	async execute() {
		if (this.table === databaseRevision) {
			d1Planning = true;
			return [{ revision: d1Revision }];
		}
		const user = await fixtureUser();
		if (d1Planning) {
			if (this.table === schema.users) return user.id ? [user] : [];
			if (this.table === schema.s3Buckets)
				return [
					{
						id: "bucket-1",
						ownerId: user.id,
						organizationId: null,
						active: true,
					},
				];
			const rows = (d1Rows.get(this.table) ?? []).filter((row) =>
				matchesD1(row, this.condition),
			);
			if (this.table === schema.organizations)
				for (const row of rows)
					row.defaultVideoVisibility = (await defaultSharing.getNewVideoPublic(
						row.id,
					))
						? "public"
						: "private";
			return rows
				.slice(0, this.maximum ?? rows.length)
				.map((row) => ({ ...row }));
		}
		mockDb.select(this.fields);
		mockDb.from(this.table);
		for (const join of this.joins) mockDb[join.kind](...join.args);
		let result = mockDb.where(this.condition);
		if (
			this.maximum !== undefined &&
			result &&
			typeof result.limit === "function"
		)
			result = mockDb.limit(this.maximum);
		const selected: unknown = await result;
		const values = Array.isArray(selected) ? (selected as D1Row[]) : [];
		if (
			this.table === schema.organizations ||
			this.table === schema.organizationMembers
		) {
			const organizations = d1Rows.get(schema.organizations) ?? [];
			for (const row of values)
				if (
					typeof row.id === "string" &&
					!organizations.some((org) => org.id === row.id)
				)
					organizations.push({
						...row,
						ownerId:
							this.table === schema.organizations ? user.id : "other-owner",
						tombstoneAt: null,
					});
			d1Rows.set(schema.organizations, organizations);
			if (this.table === schema.organizationMembers)
				d1Rows.set(
					schema.organizationMembers,
					values.map((row) => ({
						organizationId: row.id,
						userId: user.id,
						role: "member",
					})),
				);
		} else if (
			this.table === schema.videos &&
			values.some((row) => typeof row.id === "string")
		)
			d1Rows.set(schema.videos, values);
		return values;
	}
}
const d1Mock = {
	select: (fields?: unknown) => new D1Selection(fields),
	selectDistinct: (fields?: unknown) => new D1Selection(fields),
	query: {},
	insert: (table: unknown) => ({
		values: (values: D1Row) => ({ table, operation: "insert", values }),
	}),
	update: (table: unknown) => ({
		set: (values: D1Row) => ({
			where: (condition: unknown) => ({
				table,
				operation: "update",
				values,
				condition,
			}),
		}),
	}),
	delete: (table: unknown) => ({
		where: (condition: unknown) => ({ table, operation: "delete", condition }),
	}),
	async batch(statements: D1Mutation[]) {
		const guard = statements.find(
			(statement) =>
				statement.table === snapshotGuard && statement.operation === "insert",
		);
		const valid = guard?.values?.valid as { values?: unknown[] } | undefined;
		if (guard && valid?.values?.[1] !== d1Revision)
			throw new Error("CHECK constraint failed: cap_d1_snapshot_guard");
		const pending = statements.filter(
			(statement) => statement.table !== snapshotGuard,
		);
		try {
			await mockDb.transaction(async (tx: typeof mockDb) => {
				for (const statement of pending) {
					if (statement.operation === "insert")
						await tx.insert(statement.table).values(statement.values);
					else if (statement.operation === "update")
						await tx
							.update(statement.table)
							.set(statement.values)
							.where(statement.condition);
					else await tx.delete(statement.table).where(statement.condition);
				}
			});
			for (const statement of pending) {
				const rows = d1Rows.get(statement.table) ?? [];
				if (statement.operation === "insert")
					rows.push({ ...statement.values });
				else if (statement.operation === "update")
					for (const row of rows.filter((row) =>
						matchesD1(row, statement.condition),
					))
						Object.assign(row, statement.values);
				else
					d1Rows.set(
						statement.table,
						rows.filter((row) => !matchesD1(row, statement.condition)),
					);
				if (statement.operation !== "delete") d1Rows.set(statement.table, rows);
			}
			if (pending.length) d1Revision++;
			return [];
		} finally {
			d1Planning = false;
		}
	},
};

function resetMockDb() {
	d1Planning = false;
	d1Revision = 0;
	d1Rows.clear();
	for (const key of Object.keys(mockDb)) {
		const fn = mockDb[key as keyof typeof mockDb];
		if (typeof fn?.mockClear === "function") {
			fn.mockClear();
		}
	}
	mockDb.select.mockReturnValue(mockDb);
	mockDb.from.mockReturnValue(mockDb);
	mockDb.innerJoin.mockReturnValue(mockDb);
	mockDb.leftJoin.mockReturnValue(mockDb);
	mockDb.insert.mockReturnValue(mockDb);
	mockDb.values.mockResolvedValue([]);
	mockDb.update.mockReturnValue(mockDb);
	mockDb.set.mockReturnValue(mockDb);
	mockDb.where.mockResolvedValue([]);
	mockDb.for.mockResolvedValue([]);
	mockDb.limit.mockResolvedValue([]);
	mockDb.transaction.mockImplementation(
		async (fn: (tx: typeof mockDb) => unknown) => fn(mockDb),
	);
}

function insertedValues(table: unknown) {
	const index = mockDb.insert.mock.calls.findIndex(([t]) => t === table);
	if (index === -1) return undefined;
	return mockDb.values.mock.calls[index]?.[0] as
		| Record<string, unknown>
		| undefined;
}

function recordingTransactionFixture(rejectUpload: boolean) {
	type Row = Record<string, unknown>;
	type Rows = { videos: Map<string, Row>; uploads: Map<string, Row> };
	const committed: Rows = { videos: new Map(), uploads: new Map() };
	const transactionInserts: unknown[] = [];
	const directInserts: unknown[] = [];
	const insertInto = (rows: Rows, inserts: unknown[]) => (table: unknown) => {
		inserts.push(table);
		return {
			values: async (value: Row) => {
				if (table === schema.videoUploads && rejectUpload)
					throw new Error("Injected upload insert failure");
				const target =
					table === schema.videos
						? rows.videos
						: table === schema.videoUploads
							? rows.uploads
							: null;
				if (!target) throw new Error("Unexpected insert table");
				const id = String(table === schema.videos ? value.id : value.videoId);
				target.set(id, { ...value });
			},
		};
	};
	mockDb.insert.mockImplementation(insertInto(committed, directInserts));
	mockDb.transaction.mockImplementation(
		async (
			run: (tx: { insert: ReturnType<typeof insertInto> }) => Promise<unknown>,
		) => {
			const candidate: Rows = {
				videos: new Map(committed.videos),
				uploads: new Map(committed.uploads),
			};
			const result = await run({
				insert: insertInto(candidate, transactionInserts),
			});
			committed.videos = candidate.videos;
			committed.uploads = candidate.uploads;
			return result;
		},
	);
	return { committed, transactionInserts, directInserts };
}

function stubStorage() {
	const getOrganizationWritableAccess =
		Storage.getOrganizationWritableAccess as ReturnType<typeof vi.fn>;
	const getS3WritableAccessForUser =
		Storage.getS3WritableAccessForUser as ReturnType<typeof vi.fn>;
	getOrganizationWritableAccess.mockReturnValue(Effect.succeed(Option.none()));
	getS3WritableAccessForUser.mockReturnValue(
		Effect.succeed({
			bucketId: Option.some("bucket-1"),
			storageIntegrationId: Option.none(),
		}),
	);
}

describe("GET /new-id", () => {
	let app: typeof import("@/app/api/desktop/[...route]/video")["app"];

	beforeEach(async () => {
		vi.clearAllMocks();
		resetMockDb();
		stubStorage();
		mockGetCurrentUser.mockResolvedValue({
			id: "user-1",
			email: "someone@cap.test",
			defaultOrgId: "org-1",
			activeOrganizationId: "org-1",
		});
		const mod = await import("@/app/api/desktop/[...route]/video");
		app = mod.app;
	});

	it("allocates an ID without creating a video", async () => {
		const response = await app.request("https://cap.test/new-id");

		expect(response.status).toBe(200);
		expect(await response.json()).toEqual({
			id: expect.stringMatching(/^[0-9abcdefghjkmnpqrstvwxyz]{15}$/),
		});
		expect(mockDb.insert).not.toHaveBeenCalled();
	});
});

describe("DELETE /delete", () => {
	let app: typeof import("@/app/api/desktop/[...route]/video")["app"];
	const ownedVideo = {
		id: "video-1",
		ownerId: "user-1",
		storageIntegrationId: "drive-1",
	};

	beforeEach(async () => {
		vi.clearAllMocks();
		resetMockDb();
		mockGetCurrentUser.mockResolvedValue({
			id: "user-1",
			email: "owner@cap.test",
			activeOrganizationId: "org-1",
			image: null,
		});
		mockDb.where.mockResolvedValue([{ video: ownedVideo }]);
		deletion.deleteVideo
			.mockReset()
			.mockImplementation(() =>
				Effect.flatMap(CurrentUser, (principal) =>
					Effect.sync(() => deletion.principal(principal)),
				),
			);
		app = (await import("@/app/api/desktop/[...route]/video")).app;
	});

	it("delegates deletion under the authenticated principal and then invalidates quota", async () => {
		const response = await app.request(
			"https://cap.test/delete?videoId=video-1",
			{ method: "DELETE" },
		);
		expect(response.status).toBe(200);
		expect(await response.json()).toBe(true);
		expect(deletion.deleteVideo).toHaveBeenCalledExactlyOnceWith("video-1");
		expect(deletion.principal).toHaveBeenCalledWith({
			id: "user-1",
			email: "owner@cap.test",
			activeOrganizationId: "org-1",
			iconUrlOrKey: Option.none(),
		});
		expect(mockDb.delete).not.toHaveBeenCalled();
		expect(
			invalidateGoogleDriveStorageQuotaCache,
		).toHaveBeenCalledExactlyOnceWith("drive-1");
	});

	it("uses the desktop bearer principal without replacing it with a cookie session", async () => {
		mockGetCurrentUser.mockResolvedValue({ id: "cookie-user" });
		mockDb.where
			.mockResolvedValueOnce([
				{
					users: {
						id: "token-user",
						email: "token-owner@cap.test",
						activeOrganizationId: "token-org",
						image: null,
					},
				},
			])
			.mockResolvedValueOnce([
				{ video: { ...ownedVideo, ownerId: "token-user" } },
			]);
		const response = await app.request(
			"https://cap.test/delete?videoId=video-1",
			{
				method: "DELETE",
				headers: {
					Authorization: "Bearer 00000000-0000-4000-8000-000000000000",
				},
			},
		);
		expect(response.status).toBe(200);
		expect(mockGetCurrentUser).not.toHaveBeenCalled();
		expect(deletion.principal).toHaveBeenCalledWith(
			expect.objectContaining({
				id: "token-user",
				activeOrganizationId: "token-org",
			}),
		);
		expect(mockDb.delete).not.toHaveBeenCalled();
	});

	it("does not invalidate quota or return success before central deletion finishes", async () => {
		let release: (() => void) | undefined;
		const gate = new Promise<void>((resolve) => {
			release = resolve;
		});
		deletion.deleteVideo.mockReturnValue(Effect.promise(() => gate));
		const pending = app.request("https://cap.test/delete?videoId=video-1", {
			method: "DELETE",
		});
		await vi.waitFor(() =>
			expect(deletion.deleteVideo).toHaveBeenCalledTimes(1),
		);
		expect(invalidateGoogleDriveStorageQuotaCache).not.toHaveBeenCalled();
		if (!release) throw new Error("Missing central deletion resolver");
		release();
		const response = await pending;
		expect(response.status).toBe(200);
		expect(
			invalidateGoogleDriveStorageQuotaCache,
		).toHaveBeenCalledExactlyOnceWith("drive-1");
	});

	it("keeps the not-found response when no owned recording matches", async () => {
		mockDb.where.mockResolvedValue([]);
		const response = await app.request(
			"https://cap.test/delete?videoId=video-1",
			{ method: "DELETE" },
		);
		expect(response.status).toBe(404);
		expect(await response.json()).toEqual({
			error: true,
			message: "Video not found",
		});
		expect(deletion.deleteVideo).not.toHaveBeenCalled();
		expect(invalidateGoogleDriveStorageQuotaCache).not.toHaveBeenCalled();
	});

	it.each([
		{ reason: "missing", error: new Video.NotFoundError() },
		{ reason: "forbidden", error: new Policy.PolicyDeniedError() },
	])(
		"preserves 404 if the central service reports $reason after the preflight",
		async ({ error }) => {
			deletion.deleteVideo.mockReturnValue(Effect.fail(error));
			const response = await app.request(
				"https://cap.test/delete?videoId=video-1",
				{ method: "DELETE" },
			);
			expect(response.status).toBe(404);
			expect(await response.json()).toEqual({
				error: true,
				message: "Video not found",
			});
			expect(mockDb.delete).not.toHaveBeenCalled();
			expect(invalidateGoogleDriveStorageQuotaCache).not.toHaveBeenCalled();
		},
	);

	it("returns 500 without invalidating quota when central storage cleanup fails", async () => {
		deletion.deleteVideo.mockReturnValue(
			Effect.fail(
				new StorageDomain.StorageError({
					cause: new Error("Provider deletion failed"),
				}),
			),
		);
		const response = await app.request(
			"https://cap.test/delete?videoId=video-1",
			{ method: "DELETE" },
		);
		expect(response.status).toBe(500);
		expect(await response.json()).toEqual({ error: "Internal server error" });
		expect(mockDb.delete).not.toHaveBeenCalled();
		expect(invalidateGoogleDriveStorageQuotaCache).not.toHaveBeenCalled();
	});

	it("does not delegate an unauthenticated request", async () => {
		mockGetCurrentUser.mockResolvedValue(null);
		const response = await app.request(
			"https://cap.test/delete?videoId=video-1",
			{ method: "DELETE" },
		);
		expect(response.status).toBe(401);
		expect(deletion.deleteVideo).not.toHaveBeenCalled();
		expect(mockDb.select).not.toHaveBeenCalled();
	});

	it("rejects a missing recording id before deletion", async () => {
		const response = await app.request("https://cap.test/delete", {
			method: "DELETE",
		});
		expect(response.status).toBe(400);
		expect(deletion.deleteVideo).not.toHaveBeenCalled();
		expect(mockDb.delete).not.toHaveBeenCalled();
	});

	it("reports why the desktop app cleaned up an Instant start after deleting it", async () => {
		mockDb.where.mockResolvedValue([
			{ video: { ...ownedVideo, source: { type: "desktopSegments" } } },
		]);
		const response = await app.request(
			"https://cap.test/delete?videoId=video-1&reason=start-failed&cause=microphone",
			{
				method: "DELETE",
				headers: { "X-Cap-Desktop-Features": "googleDriveUpload,gpui" },
			},
		);
		expect(response.status).toBe(200);
		expect(await response.json()).toBe(true);
		expect(trackServerEvent).toHaveBeenCalledExactlyOnceWith(
			"user-1",
			"desktop_instant_cleanup",
			{
				reason: "start-failed",
				cause: "microphone",
				app: "gpui",
				sourceType: "desktopSegments",
			},
		);
	});

	it.each([
		"https://cap.test/delete?videoId=video-1",
		"https://cap.test/delete?videoId=video-1&reason=unknown&cause=microphone",
	])(
		"deletes without reporting when no known reason is sent: %s",
		async (url) => {
			const response = await app.request(url, { method: "DELETE" });
			expect(response.status).toBe(200);
			expect(await response.json()).toBe(true);
			expect(deletion.deleteVideo).toHaveBeenCalledExactlyOnceWith("video-1");
			expect(trackServerEvent).not.toHaveBeenCalled();
		},
	);

	it("drops an unknown cause and labels other desktop apps", async () => {
		const response = await app.request(
			"https://cap.test/delete?videoId=video-1&reason=interrupted&cause=../../etc",
			{ method: "DELETE" },
		);
		expect(response.status).toBe(200);
		expect(trackServerEvent).toHaveBeenCalledExactlyOnceWith(
			"user-1",
			"desktop_instant_cleanup",
			{ reason: "interrupted", cause: null, app: "desktop", sourceType: null },
		);
	});

	it("reports nothing when the deletion itself fails", async () => {
		deletion.deleteVideo.mockReturnValue(
			Effect.fail(
				new StorageDomain.StorageError({
					cause: new Error("Provider deletion failed"),
				}),
			),
		);
		const response = await app.request(
			"https://cap.test/delete?videoId=video-1&reason=start-failed",
			{ method: "DELETE" },
		);
		expect(response.status).toBe(500);
		expect(trackServerEvent).not.toHaveBeenCalled();
	});
});

describe("GET /create", () => {
	afterEach(() => vi.unstubAllEnvs());
	let app: typeof import("@/app/api/desktop/[...route]/video")["app"];

	beforeEach(async () => {
		vi.clearAllMocks();
		resetMockDb();
		stubStorage();
		defaultSharing.getNewVideoPublic.mockResolvedValue(true);
		const mod = await import("@/app/api/desktop/[...route]/video");
		app = mod.app;
	});

	it("provisions a personal org for the configured owner with no org", async () => {
		vi.stubEnv("CAP_OWNER_EMAIL", "grant@cap.test");
		mockGetCurrentUser.mockResolvedValue({
			id: "user-1",
			email: "grant@cap.test",
			defaultOrgId: null,
			activeOrganizationId: "",
		});
		mockDb.where
			.mockResolvedValueOnce([])
			.mockResolvedValueOnce([])
			.mockResolvedValueOnce([])
			.mockResolvedValueOnce([{ count: 5 }]);

		const response = await app.request("https://cap.test/create");

		expect(response.status).toBe(200);
		expect(mockDb.transaction).toHaveBeenCalledTimes(2);

		const orgValues = insertedValues(schema.organizations) as
			| { id: string; ownerId: string; name: string }
			| undefined;
		expect(orgValues).toMatchObject({
			ownerId: "user-1",
			name: "My Organization",
		});

		expect(insertedValues(schema.organizationMembers)).toMatchObject({
			userId: "user-1",
			role: "owner",
			organizationId: orgValues?.id,
		});

		expect(mockDb.set).toHaveBeenCalledWith(
			expect.objectContaining({
				activeOrganizationId: orgValues?.id,
				defaultOrgId: orgValues?.id,
			}),
		);

		expect(insertedValues(schema.videos)).toMatchObject({
			orgId: orgValues?.id,
			ownerId: "user-1",
		});

		const body = await response.json();
		expect(body.id).toBeTruthy();
	});

	it("does not provision when the user already belongs to an org", async () => {
		mockGetCurrentUser.mockResolvedValue({
			id: "user-1",
			email: "someone@cap.test",
			defaultOrgId: "org-1",
			activeOrganizationId: "org-1",
		});
		mockDb.where
			.mockResolvedValueOnce([
				{ id: "org-1", name: "Acme", createdAt: new Date() },
			])
			.mockResolvedValueOnce([])
			.mockResolvedValueOnce([{ count: 5 }]);

		const response = await app.request("https://cap.test/create");

		expect(response.status).toBe(200);
		expect(mockDb.transaction).toHaveBeenCalledTimes(1);

		expect(insertedValues(schema.videos)).toMatchObject({
			orgId: "org-1",
			ownerId: "user-1",
		});
	});

	it("creates a private recording when the organization default resolves to private", async () => {
		defaultSharing.getNewVideoPublic.mockResolvedValue(false);
		mockGetCurrentUser.mockResolvedValue({
			id: "user-1",
			email: "someone@cap.test",
			defaultOrgId: "org-1",
			activeOrganizationId: "org-1",
		});
		mockDb.where
			.mockResolvedValueOnce([
				{ id: "org-1", name: "Acme", createdAt: new Date() },
			])
			.mockResolvedValueOnce([])
			.mockResolvedValueOnce([{ count: 5 }]);

		const response = await app.request("https://cap.test/create");

		expect(response.status).toBe(200);
		expect(defaultSharing.getNewVideoPublic).toHaveBeenCalledWith("org-1");
		expect(insertedValues(schema.videos)).toMatchObject({
			orgId: "org-1",
			public: false,
		});
	});

	it("heals a dangling defaultOrgId for the configured owner", async () => {
		vi.stubEnv("CAP_OWNER_EMAIL", "grant@cap.test");
		mockGetCurrentUser.mockResolvedValue({
			id: "user-1",
			email: "grant@cap.test",
			defaultOrgId: "org-stale",
			activeOrganizationId: "",
		});
		mockDb.where
			.mockResolvedValueOnce([])
			.mockResolvedValueOnce([])
			.mockResolvedValueOnce([])
			.mockResolvedValueOnce([])
			.mockResolvedValueOnce([{ count: 5 }]);

		const response = await app.request("https://cap.test/create");

		expect(response.status).toBe(200);
		expect(mockDb.transaction).toHaveBeenCalledTimes(2);

		const orgValues = insertedValues(schema.organizations) as
			| { id: string }
			| undefined;

		expect(insertedValues(schema.videos)).toMatchObject({
			orgId: orgValues?.id,
		});
	});

	it("routes a stale explicit orgId to the configured owner fallback org", async () => {
		vi.stubEnv("CAP_OWNER_EMAIL", "grant@cap.test");
		mockGetCurrentUser.mockResolvedValue({
			id: "user-1",
			email: "grant@cap.test",
			defaultOrgId: "org-stale",
			activeOrganizationId: "",
		});
		mockDb.where
			.mockResolvedValueOnce([])
			.mockResolvedValueOnce([])
			.mockResolvedValueOnce([])
			.mockResolvedValueOnce([])
			.mockResolvedValueOnce([{ count: 5 }]);

		const response = await app.request(
			"https://cap.test/create?orgId=org-stale",
		);

		expect(response.status).toBe(200);
		expect(mockDb.transaction).toHaveBeenCalledTimes(2);

		const orgValues = insertedValues(schema.organizations) as
			| { id: string }
			| undefined;

		expect(insertedValues(schema.videos)).toMatchObject({
			orgId: orgValues?.id,
		});

		expect(mockDb.set).toHaveBeenCalledWith(
			expect.objectContaining({ defaultOrgId: orgValues?.id }),
		);
	});

	it("falls back to the default org when a stale explicit orgId is sent and the user still has orgs", async () => {
		mockGetCurrentUser.mockResolvedValue({
			id: "user-1",
			email: "someone@cap.test",
			defaultOrgId: "org-1",
			activeOrganizationId: "org-1",
		});
		mockDb.where
			.mockResolvedValueOnce([
				{ id: "org-1", name: "Acme", createdAt: new Date() },
			])
			.mockResolvedValueOnce([])
			.mockResolvedValueOnce([{ count: 5 }]);

		const response = await app.request(
			"https://cap.test/create?orgId=org-stale",
		);

		expect(response.status).toBe(200);
		expect(mockDb.transaction).toHaveBeenCalledTimes(1);

		expect(insertedValues(schema.videos)).toMatchObject({
			orgId: "org-1",
			ownerId: "user-1",
		});
	});

	it("honours an explicit orgId the user belongs to", async () => {
		mockGetCurrentUser.mockResolvedValue({
			id: "user-1",
			email: "someone@cap.test",
			defaultOrgId: "org-1",
			activeOrganizationId: "org-1",
		});
		mockDb.where
			.mockResolvedValueOnce([
				{ id: "org-1", name: "Acme", createdAt: new Date() },
			])
			.mockResolvedValueOnce([
				{ id: "org-2", name: "Team", createdAt: new Date() },
			])
			.mockResolvedValueOnce([{ count: 5 }]);

		const response = await app.request("https://cap.test/create?orgId=org-2");

		expect(response.status).toBe(200);
		expect(mockDb.transaction).toHaveBeenCalledTimes(1);

		expect(insertedValues(schema.videos)).toMatchObject({
			orgId: "org-2",
			ownerId: "user-1",
		});
	});

	it("creates a missing video with an explicitly reserved ID", async () => {
		mockGetCurrentUser.mockResolvedValue({
			id: "user-1",
			email: "someone@cap.test",
			defaultOrgId: "org-1",
			activeOrganizationId: "org-1",
		});
		mockDb.where
			.mockResolvedValueOnce([])
			.mockResolvedValueOnce([
				{ id: "org-1", name: "Acme", createdAt: new Date() },
			])
			.mockResolvedValueOnce([])
			.mockResolvedValueOnce([{ count: 5 }]);

		const response = await app.request(
			"https://cap.test/create?videoId=0123456789abcde&createWithId=true",
		);

		expect(response.status).toBe(200);
		expect(insertedValues(schema.videos)).toMatchObject({
			id: "0123456789abcde",
			ownerId: "user-1",
		});
		expect(await response.json()).toMatchObject({ id: "0123456789abcde" });
	});

	it("commits a progress-capable recording and its upload row in one transaction", async () => {
		mockGetCurrentUser.mockResolvedValue({
			id: "fixture-user",
			email: "fixture@example.com",
			defaultOrgId: "fixture-org",
			activeOrganizationId: "fixture-org",
		});
		mockDb.where
			.mockResolvedValueOnce([
				{
					id: "fixture-org",
					name: "Fixture organization",
					createdAt: new Date("2026-01-01T00:00:00.000Z"),
				},
			])
			.mockResolvedValueOnce([]);
		const fixture = recordingTransactionFixture(false);

		const response = await app.request(
			"https://cap.test/create?recordingMode=desktopMP4",
			{ headers: { "X-Cap-Desktop-Version": "0.3.68" } },
		);

		expect(response.status).toBe(200);
		expect(mockDb.transaction).toHaveBeenCalledTimes(1);
		expect(fixture.transactionInserts).toEqual([
			schema.videos,
			schema.videoUploads,
		]);
		expect(fixture.directInserts).toEqual([]);
		const body = await response.json();
		expect(fixture.committed.videos.get(body.id)).toMatchObject({
			id: body.id,
			ownerId: "fixture-user",
			orgId: "fixture-org",
		});
		expect(fixture.committed.uploads.get(body.id)).toMatchObject({
			videoId: body.id,
			mode: "singlepart",
		});
	});

	it("rolls back a recording and skips transcription when its upload insert fails", async () => {
		mockGetCurrentUser.mockResolvedValue({
			id: "fixture-user",
			email: "fixture@example.com",
			defaultOrgId: "fixture-org",
			activeOrganizationId: "fixture-org",
		});
		mockDb.where
			.mockResolvedValueOnce([
				{
					id: "fixture-org",
					name: "Fixture organization",
					createdAt: new Date("2026-01-01T00:00:00.000Z"),
				},
			])
			.mockResolvedValueOnce([]);
		const fixture = recordingTransactionFixture(true);
		vi.spyOn(console, "error").mockImplementation(() => undefined);

		const response = await app.request(
			"https://cap.test/create?recordingMode=desktopSegments",
			{ headers: { "X-Cap-Desktop-Version": "0.3.68" } },
		);

		expect(response.status).toBe(500);
		expect(mockDb.transaction).toHaveBeenCalledTimes(1);
		expect(fixture.transactionInserts).toEqual([
			schema.videos,
			schema.videoUploads,
		]);
		expect(fixture.directInserts).toEqual([]);
		expect(fixture.committed.videos.size).toBe(0);
		expect(fixture.committed.uploads.size).toBe(0);
		expect(maybeStartLiveTranscription).not.toHaveBeenCalled();
	});

	it("rejects an invalid client-selected video ID", async () => {
		mockGetCurrentUser.mockResolvedValue({
			id: "user-1",
			email: "someone@cap.test",
			defaultOrgId: "org-1",
			activeOrganizationId: "org-1",
		});

		const response = await app.request(
			"https://cap.test/create?videoId=not-valid&createWithId=true",
		);

		expect(response.status).toBe(400);
		expect(await response.json()).toEqual({ error: "invalid_video_id" });
		expect(mockDb.insert).not.toHaveBeenCalled();
	});
});
