import { AsyncLocalStorage } from "node:async_hooks";
import type { CloudflareDatabase } from "@cap/database/cloudflare";
import type {
	AtomicPlan,
	AtomicSnapshot,
} from "@cap/database/cloudflare/atomic";
import * as schema from "@cap/database/cloudflare/schema";
import { Option } from "effect";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createRecordingD1Model } from "../helpers/recording-d1-model";

const planningContext = new AsyncLocalStorage<boolean>();
vi.mock("@cap/database/cloudflare/atomic", async (importOriginal) => {
	const original =
		await importOriginal<typeof import("@cap/database/cloudflare/atomic")>();
	return {
		...original,
		atomic: <T>(
			database: CloudflareDatabase,
			planner: (snapshot: AtomicSnapshot) => Promise<AtomicPlan<T>>,
			options?: { maxAttempts?: number },
		) =>
			original.atomic(
				database,
				(snapshot) => planningContext.run(true, () => planner(snapshot)),
				options,
			),
	};
});
const mocks = vi.hoisted(() => ({
	db: vi.fn(),
	decodeStorageVideo: vi.fn(),
	getAccessForVideo: vi.fn(),
	getCurrentUser: vi.fn(),
	runPromise: vi.fn(),
	start: vi.fn(),
}));

vi.mock("@cap/database/cloudflare/application", () => ({
	db: mocks.db,
}));

vi.mock("@cap/database/auth/session", () => ({
	getCurrentUser: mocks.getCurrentUser,
}));

vi.mock("@cap/utils", () => ({
	userIsPro: () => true,
}));

vi.mock("@cap/web-backend", () => ({
	Storage: {
		getAccessForVideo: mocks.getAccessForVideo,
	},
}));

vi.mock("workflow/api", () => ({
	start: mocks.start,
}));

vi.mock("@/lib/server", () => ({
	runPromise: mocks.runPromise,
}));

vi.mock("@cap/database/transcript-encryption", () => ({
	decryptEditTranscriptObject: (value: string) => value,
}));

vi.mock("@/lib/video-storage", () => ({
	decodeStorageVideo: mocks.decodeStorageVideo,
}));

vi.mock("@/workflows/transcribe", () => ({
	backfillEditTranscriptWorkflow: vi.fn(),
}));

vi.mock("server-only", () => ({}));

type PipeValue<T> = {
	pipe: (runner: (value: T) => unknown) => unknown;
};

function pipeValue<T>(value: T): PipeValue<T> {
	return {
		pipe: (runner) => runner(value),
	};
}

function createDatabase(
	video: Record<string, unknown>,
	edit?: Record<string, unknown>,
) {
	const currentVideo: Record<string, unknown> = {
		metadata: null,
		updatedAt: new Date("2026-07-30T00:00:00.000Z"),
		...video,
	};
	const applied = vi.fn();
	const database = createRecordingD1Model({
		read: async ({ table }) => {
			if (table === schema.videos) return [structuredClone(currentVideo)];
			if (table === schema.videoEdits)
				return edit ? [structuredClone(edit)] : [];
			return [];
		},
		apply: (statements) => {
			for (const statement of statements) {
				if (
					statement.table === schema.videos &&
					statement.operation === "update"
				) {
					applied(statement.values);
					Object.assign(currentVideo, statement.values);
				}
			}
		},
		signature: () => JSON.stringify(currentVideo),
	});
	return {
		database,
		isTransactionActive: () => planningContext.getStore() === true,
		applied,
	};
}

function createBucket(
	objects: Map<string, string>,
	isTransactionActive = () => false,
) {
	return {
		getObject: vi.fn((key: string) => {
			if (isTransactionActive()) {
				throw new Error("Storage read occurred inside a database transaction");
			}
			return pipeValue(Option.fromNullable(objects.get(key)));
		}),
	};
}

const video = {
	id: "video-1",
	ownerId: "user-1",
	duration: 25,
	source: { type: "webMP4" },
	isScreenshot: false,
	transcriptionStatus: "COMPLETE",
	updatedAt: new Date("2026-07-30T00:00:00.000Z"),
};

const TRANSCRIPT_KEY = "user-1/video-1/transcription.edit.v3.json";

function storedOriginalTranscript(durationMs = 25_000) {
	return JSON.stringify({
		version: 3,
		speechModelUsed: "universal-3-5-pro",
		durationMs,
		languageCode: "en",
		words: [
			{
				id: "word-0-1000-1500",
				text: "before",
				startMs: 1_000,
				endMs: 1_500,
				confidence: 0.9,
				speaker: null,
				channel: null,
			},
			{
				id: "word-1-6000-6500",
				text: "kept",
				startMs: 6_000,
				endMs: 6_500,
				confidence: 0.9,
				speaker: null,
				channel: null,
			},
			{
				id: "word-2-20000-20500",
				text: "after",
				startMs: 20_000,
				endMs: 20_500,
				confidence: 0.9,
				speaker: null,
				channel: null,
			},
		],
	});
}

beforeEach(() => {
	vi.clearAllMocks();
	mocks.getCurrentUser.mockResolvedValue({ id: "user-1" });
	mocks.runPromise.mockImplementation((value) => Promise.resolve(value));
	mocks.start.mockResolvedValue({ runId: "run-1" });
});

describe("requestEditTranscript", () => {
	it("serializes concurrent requests and starts one paid transcript job", async () => {
		const objects = new Map<string, string>();
		const { database, isTransactionActive, applied } = createDatabase(video);
		const bucket = createBucket(objects, isTransactionActive);
		mocks.db.mockReturnValue(database);
		mocks.getAccessForVideo.mockReturnValue(pipeValue([bucket]));
		mocks.start.mockImplementation(async () => {
			if (isTransactionActive()) {
				throw new Error(
					"Workflow start occurred inside a database transaction",
				);
			}
			return { runId: "run-1" };
		});

		const { requestEditTranscript } = await import(
			"@/actions/videos/get-edit-transcript"
		);
		const [first, second] = await Promise.all([
			requestEditTranscript("video-1" as never),
			requestEditTranscript("video-1" as never),
		]);

		expect(first).toEqual({ status: "processing" });
		expect(second).toEqual({ status: "processing" });
		expect(mocks.start).toHaveBeenCalledTimes(1);
		expect(applied).toHaveBeenCalledTimes(1);
		expect(applied.mock.calls[0]?.[0]).toMatchObject({
			metadata: { editTranscriptBackfill: { status: "processing" } },
		});
		expect(mocks.start.mock.calls[0]?.[1]?.[0]).toMatchObject({
			videoId: "video-1",
			userId: "user-1",
			requestId: expect.any(String),
		});
	});

	it("returns a current cached sidecar without starting another job", async () => {
		const objects = new Map<string, string>([
			[
				TRANSCRIPT_KEY,
				JSON.stringify({
					version: 3,
					speechModelUsed: "universal-3-5-pro",
					durationMs: 25_000,
					languageCode: "en",
					words: [],
				}),
			],
		]);
		const bucket = createBucket(objects);
		const { database } = createDatabase(video);
		mocks.db.mockReturnValue(database);
		mocks.getAccessForVideo.mockReturnValue(pipeValue([bucket]));

		const { requestEditTranscript } = await import(
			"@/actions/videos/get-edit-transcript"
		);
		const response = await requestEditTranscript("video-1" as never);

		expect(response.status).toBe("ready");
		expect(mocks.start).not.toHaveBeenCalled();
	});

	it("remaps the stored original words through the video's edit spec", async () => {
		const objects = new Map<string, string>([
			[TRANSCRIPT_KEY, storedOriginalTranscript()],
		]);
		const bucket = createBucket(objects);
		const { database } = createDatabase(
			{ ...video, duration: 10 },
			{
				editSpec: {
					version: 1,
					sourceDuration: 25,
					keepRanges: [{ start: 5, end: 15 }],
				},
			},
		);
		mocks.db.mockReturnValue(database);
		mocks.getAccessForVideo.mockReturnValue(pipeValue([bucket]));

		const { requestEditTranscript } = await import(
			"@/actions/videos/get-edit-transcript"
		);
		const response = await requestEditTranscript("video-1" as never);

		if (response.status !== "ready") {
			throw new Error(`Expected a ready transcript, got ${response.status}`);
		}
		expect(response.transcript.durationMs).toBe(10_000);
		expect(
			response.transcript.words.map((word) => [
				word.id,
				word.startMs,
				word.endMs,
			]),
		).toEqual([["word-1-6000-6500", 1_000, 1_500]]);
		expect(mocks.start).not.toHaveBeenCalled();
	});

	it("does not expose workflow startup errors to the client", async () => {
		const bucket = createBucket(new Map());
		const { database } = createDatabase(video);
		mocks.db.mockReturnValue(database);
		mocks.getAccessForVideo.mockReturnValue(pipeValue([bucket]));
		mocks.start.mockRejectedValue(
			new Error("provider account and request identifiers"),
		);
		const consoleError = vi
			.spyOn(console, "error")
			.mockImplementation(() => undefined);

		const { requestEditTranscript } = await import(
			"@/actions/videos/get-edit-transcript"
		);
		const response = await requestEditTranscript("video-1" as never);

		expect(response).toEqual({
			status: "error",
			message: "Transcript preparation could not start. Try again.",
		});
		expect(JSON.stringify(response)).not.toContain("provider account");
		consoleError.mockRestore();
	});
});

describe("getEditTranscript", () => {
	it.each([true, false])(
		"uses only the current transcript publication (edit=%s)",
		async (edit) => {
			const pointer = {
				version: 1,
				id: "e8dc5891-8475-4e31-a56c-327fd3f08656",
				vtt: false,
				edit,
				revision: null,
			};
			const key = `user-1/video-1/.transcripts/${pointer.id}/transcription.edit.v3.json`;
			const bucket = createBucket(
				new Map([
					[TRANSCRIPT_KEY, storedOriginalTranscript(18000)],
					[key, storedOriginalTranscript()],
				]),
			);
			const { database } = createDatabase({
				...video,
				metadata: { transcriptPublication: pointer },
			});
			mocks.db.mockReturnValue(database);
			mocks.getAccessForVideo.mockReturnValue(pipeValue([bucket]));
			const { getEditTranscript } = await import(
				"@/actions/videos/get-edit-transcript"
			);
			expect((await getEditTranscript("video-1" as never)).status).toBe(
				edit ? "ready" : "missing",
			);
			if (edit) expect(bucket.getObject).toHaveBeenCalledWith(key);
			else expect(bucket.getObject).not.toHaveBeenCalled();
			expect(bucket.getObject).not.toHaveBeenCalledWith(TRANSCRIPT_KEY);
		},
	);

	it("does not fall back to a historical sidecar when a published artifact is missing", async () => {
		const pointer = {
			version: 1,
			id: "e8dc5891-8475-4e31-a56c-327fd3f08656",
			vtt: false,
			edit: true,
			revision: null,
		};
		const bucket = createBucket(
			new Map([[TRANSCRIPT_KEY, storedOriginalTranscript()]]),
		);
		const { database } = createDatabase({
			...video,
			metadata: { transcriptPublication: pointer },
		});
		mocks.db.mockReturnValue(database);
		mocks.getAccessForVideo.mockReturnValue(pipeValue([bucket]));
		const consoleError = vi
			.spyOn(console, "error")
			.mockImplementation(() => undefined);
		const { getEditTranscript } = await import(
			"@/actions/videos/get-edit-transcript"
		);
		expect(await getEditTranscript("video-1" as never)).toEqual({
			status: "error",
			message: "Transcript unavailable",
		});
		expect(bucket.getObject).not.toHaveBeenCalledWith(TRANSCRIPT_KEY);
		consoleError.mockRestore();
	});

	it("remaps stored words instead of reporting them as stale", async () => {
		const objects = new Map<string, string>([
			[TRANSCRIPT_KEY, storedOriginalTranscript()],
		]);
		const bucket = createBucket(objects);
		const { database } = createDatabase(
			{ ...video, duration: 10 },
			{
				editSpec: {
					version: 1,
					sourceDuration: 25,
					keepRanges: [{ start: 5, end: 15 }],
				},
			},
		);
		mocks.db.mockReturnValue(database);
		mocks.getAccessForVideo.mockReturnValue(pipeValue([bucket]));

		const { getEditTranscript } = await import(
			"@/actions/videos/get-edit-transcript"
		);
		const response = await getEditTranscript("video-1" as never);

		if (response.status !== "ready") {
			throw new Error(`Expected a ready transcript, got ${response.status}`);
		}
		expect(response.transcript.words.map((word) => word.text)).toEqual([
			"kept",
		]);
	});

	it("reports missing when the sidecar no longer matches the original media", async () => {
		const objects = new Map<string, string>([
			[TRANSCRIPT_KEY, storedOriginalTranscript(18_000)],
		]);
		const bucket = createBucket(objects);
		const { database } = createDatabase(
			{ ...video, duration: 10 },
			{
				editSpec: {
					version: 1,
					sourceDuration: 25,
					keepRanges: [{ start: 5, end: 15 }],
				},
			},
		);
		mocks.db.mockReturnValue(database);
		mocks.getAccessForVideo.mockReturnValue(pipeValue([bucket]));

		const { getEditTranscript } = await import(
			"@/actions/videos/get-edit-transcript"
		);

		expect(await getEditTranscript("video-1" as never)).toEqual({
			status: "missing",
		});
	});

	it("reports only a generic message for a failed backfill", async () => {
		const bucket = createBucket(new Map());
		const { database } = createDatabase({
			...video,
			metadata: {
				editTranscriptBackfill: {
					status: "error",
					requestId: "request-1",
					requestedAt: "2026-07-30T00:00:00.000Z",
					message: "private provider detail",
				},
			},
		});
		mocks.db.mockReturnValue(database);
		mocks.getAccessForVideo.mockReturnValue(pipeValue([bucket]));

		const { getEditTranscript } = await import(
			"@/actions/videos/get-edit-transcript"
		);

		expect(await getEditTranscript("video-1" as never)).toEqual({
			status: "error",
			message: "Transcript preparation failed. Try again.",
		});
	});
});
