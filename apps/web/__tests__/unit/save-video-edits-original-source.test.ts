import type { SQL } from "drizzle-orm";
import { SQLiteSyncDialect } from "drizzle-orm/sqlite-core";
import { Effect } from "effect";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
	databaseRevision,
	snapshotGuard,
} from "../../../../packages/database/cloudflare/concurrency-schema";

const tables = vi.hoisted(() => ({
	videos: { id: "videos.id" },
	videoUploads: { videoId: "videoUploads.videoId" },
	videoEdits: { videoId: "videoEdits.videoId" },
}));

const state = vi.hoisted(() => ({
	rows: new Map<unknown, unknown[]>(),
}));

const headObjectMock = vi.fn();
const copyObjectMock = vi.fn();
const clearPendingEditMock = vi.fn();
const startMock = vi.fn();

function selectFromRows() {
	return {
		from: (table: unknown) => ({
			where: () => {
				const rows =
					table === databaseRevision
						? [{ revision: currentRevision() }]
						: (state.rows.get(table) ?? []);
				return Object.assign(Promise.resolve(rows), {
					for: () => Promise.resolve(rows),
				});
			},
		}),
	};
}

let revision = 0;
let signature = "";
const currentRevision = () => {
	const next = JSON.stringify([...state.rows.values()]);
	if (next !== signature) {
		signature = next;
		revision++;
	}
	return revision;
};
vi.mock("@cap/database/cloudflare/application", () => ({
	db: () => ({
		select: selectFromRows,
		selectDistinct: selectFromRows,
		query: {},
		insert: (table: unknown) => ({
			values: (data: Record<string, unknown>) => ({
				operation: "insert",
				table,
				data,
			}),
		}),
		update: (table: unknown) => ({
			set: (data: Record<string, unknown>) => ({
				where: () => ({ operation: "update", table, data }),
			}),
		}),
		delete: (table: unknown) => ({
			where: () => ({ operation: "delete", table }),
		}),
		batch: async (
			statements: Array<{
				operation: string;
				table: unknown;
				data?: Record<string, unknown>;
			}>,
		) => {
			const guard = statements.find(
				(statement) =>
					statement.table === snapshotGuard && statement.operation === "insert",
			);
			if (
				guard &&
				new SQLiteSyncDialect().sqlToQuery(guard.data?.valid as SQL)
					.params[0] !== currentRevision()
			)
				throw new Error("CHECK constraint failed: cap_d1_snapshot_guard");
			for (const statement of statements) {
				if (statement.table === snapshotGuard) continue;
				if (statement.operation === "delete")
					state.rows.set(statement.table, []);
				else if (statement.operation === "insert")
					state.rows.set(statement.table, [statement.data]);
				else
					for (const row of state.rows.get(statement.table) ?? [])
						if (row && typeof row === "object")
							Object.assign(row, statement.data);
			}
			return [];
		},
	}),
}));
vi.mock("@cap/database/cloudflare/schema", async (importOriginal) => {
	const actual =
		await importOriginal<typeof import("@cap/database/cloudflare/schema")>();
	Object.assign(tables, {
		videos: actual.videos,
		videoUploads: actual.videoUploads,
		videoEdits: actual.videoEdits,
	});
	return actual;
});

vi.mock("@cap/database/auth/session", () => ({
	getCurrentUser: async () => ({ id: "user-1", isPro: true }),
}));

vi.mock("@cap/env", () => ({ serverEnv: () => ({}) }));

vi.mock("@cap/utils", () => ({
	userIsPro: (user?: { isPro?: boolean } | null) => Boolean(user?.isPro),
}));

vi.mock("@cap/web-backend", () => ({
	Storage: {
		getAccessForVideo: () =>
			Effect.succeed([
				{
					bucketName: "cap-bucket",
					headObject: headObjectMock,
					copyObject: copyObjectMock,
				},
			]),
	},
}));

vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
vi.mock("workflow/api", () => ({ start: startMock }));
vi.mock("server-only", () => ({}));
vi.mock("@/lib/server", () => ({ runPromise: Effect.runPromise }));
vi.mock("@/lib/video-storage", () => ({ decodeStorageVideo: vi.fn() }));
vi.mock("@/lib/legacy-video-edit-recovery", () => ({
	assertLegacyEditsQuiescent: vi.fn(),
}));
vi.mock("@/lib/video-edit-operation", () => ({
	clearPendingEdit: clearPendingEditMock,
}));
vi.mock("@/utils/flags", () => ({ isAiGenerationEnabled: async () => false }));
vi.mock("@/workflows/edit-video", () => ({ editVideoWorkflow: {} }));

const sourceKey = "user-1/video-1/source/original.mp4";

function storageError(cause: unknown) {
	return { _tag: "StorageError", cause: { _tag: "S3Error", cause } };
}

function s3Error(name: string, httpStatusCode: number) {
	return Object.assign(new Error(name), {
		name,
		$metadata: { httpStatusCode },
	});
}

function setUpVideo({ edited }: { edited: boolean }) {
	const video = {
		id: "video-1",
		ownerId: "user-1",
		duration: edited ? 120 : 600,
		source: { type: "webMP4" },
		bucket: null,
		storageIntegrationId: null,
		isScreenshot: false,
		metadata: null,
	};
	state.rows.set(tables.videos, [video]);
	state.rows.set(tables.videoUploads, []);
	state.rows.set(
		tables.videoEdits,
		edited
			? [
					{
						videoId: "video-1",
						sourceKey,
						editSpec: {
							version: 1,
							sourceDuration: 600,
							keepRanges: [{ start: 0, end: 120 }],
						},
					},
				]
			: [],
	);
}

async function saveTrim(end: number) {
	const { saveVideoEdits } = await import("@/actions/videos/save-edits");
	return saveVideoEdits("video-1" as never, {
		version: 1,
		sourceDuration: 600,
		keepRanges: [{ start: 0, end }],
	});
}

describe("saveVideoEdits original source copy", () => {
	beforeEach(async () => {
		await import("@cap/database/cloudflare/schema");
		vi.clearAllMocks();
		state.rows.clear();
		copyObjectMock.mockReturnValue(Effect.succeed({}));
	});

	it("keeps the preserved original when its HEAD request fails transiently", async () => {
		setUpVideo({ edited: true });
		headObjectMock.mockReturnValue(
			Effect.fail(storageError(s3Error("SlowDown", 503))),
		);

		await expect(saveTrim(60)).rejects.toBeDefined();

		expect(copyObjectMock).not.toHaveBeenCalled();
		expect(startMock).not.toHaveBeenCalled();
		expect(clearPendingEditMock).toHaveBeenCalledOnce();
	});

	it("keeps the preserved original when the HEAD request hits a network error", async () => {
		setUpVideo({ edited: true });
		headObjectMock.mockReturnValue(
			Effect.fail(storageError(new Error("socket hang up"))),
		);

		await expect(saveTrim(60)).rejects.toBeDefined();

		expect(copyObjectMock).not.toHaveBeenCalled();
	});

	it("preserves the current result as the original on the first edit", async () => {
		setUpVideo({ edited: false });
		headObjectMock.mockReturnValue(
			Effect.fail(storageError(s3Error("NotFound", 404))),
		);

		await expect(saveTrim(300)).resolves.toEqual({ success: true });

		expect(copyObjectMock).toHaveBeenCalledWith(
			"cap-bucket/user-1/video-1/result.mp4",
			sourceKey,
		);
		expect(startMock).toHaveBeenCalledOnce();
	});

	it("treats a Google Drive 404 as a missing original", async () => {
		setUpVideo({ edited: false });
		headObjectMock.mockReturnValue(
			Effect.fail(
				storageError(
					Object.assign(new Error("Storage object not found"), {
						name: "GoogleDriveRequestError",
						status: 404,
					}),
				),
			),
		);

		await expect(saveTrim(300)).resolves.toEqual({ success: true });

		expect(copyObjectMock).toHaveBeenCalledOnce();
	});

	it("does not copy when the preserved original exists", async () => {
		setUpVideo({ edited: true });
		headObjectMock.mockReturnValue(Effect.succeed({ ContentLength: 1 }));

		await expect(saveTrim(60)).resolves.toEqual({ success: true });

		expect(copyObjectMock).not.toHaveBeenCalled();
	});
	it("does not replace a missing preserved original with the already-edited result", async () => {
		setUpVideo({ edited: true });
		headObjectMock.mockReturnValue(
			Effect.fail(storageError(s3Error("NotFound", 404))),
		);
		await expect(saveTrim(60)).rejects.toThrow(
			"Original editing base is no longer available",
		);
		expect(copyObjectMock).not.toHaveBeenCalled();
		expect(startMock).not.toHaveBeenCalled();
	});
});
