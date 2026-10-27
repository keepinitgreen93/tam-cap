import * as Db from "@cap/database/cloudflare/schema";
import { User, Video } from "@cap/web-domain";
import { Effect } from "effect";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createRecordingD1Model } from "../helpers/recording-d1-model";

const mocks = vi.hoisted(() => ({
	video: {} as Record<string, unknown>,
	upload: undefined as Record<string, unknown> | undefined,
	edit: undefined as Record<string, unknown> | undefined,
	writes: [] as string[],
	auth: vi.fn(),
	start: vi.fn(),
	quiescent: vi.fn(),
	head: vi.fn(),
	copy: vi.fn(),
	access: vi.fn(),
	fetch: vi.fn(),
	clear: vi.fn(),
}));
vi.mock("@cap/database/cloudflare/application", () => ({
	db: () => client,
}));
const client = createRecordingD1Model({
	read: ({ table }) => {
		const value =
			table === Db.videos
				? mocks.video
				: table === Db.videoUploads
					? mocks.upload
					: table === Db.videoEdits
						? mocks.edit
						: undefined;
		return value ? [structuredClone(value)] : [];
	},
	apply: (statements) => {
		for (const statement of statements) {
			const name =
				statement.table === Db.videos
					? "video"
					: statement.table === Db.videoUploads
						? "upload"
						: "edit";
			mocks.writes.push(`${statement.operation}-${name}`);
			if (statement.operation === "delete") {
				if (name === "upload") mocks.upload = undefined;
				if (name === "edit") mocks.edit = undefined;
			} else {
				if (Array.isArray(statement.values))
					throw Error("Unexpected array mutation");
				if (name === "video") Object.assign(mocks.video, statement.values);
				if (name === "upload")
					mocks.upload = { ...mocks.upload, ...statement.values };
				if (name === "edit")
					mocks.edit = { ...mocks.edit, ...statement.values };
			}
		}
	},
	signature: () => JSON.stringify([mocks.video, mocks.upload, mocks.edit]),
});
vi.mock("@cap/database/auth/session", () => ({ getCurrentUser: mocks.auth }));
vi.mock("@cap/utils", () => ({
	userIsPro: (user: { isPro: boolean }) => user.isPro,
}));
vi.mock("@cap/env", () => ({
	serverEnv: () => ({ MEDIA_SERVER_URL: "https://media.test" }),
}));
vi.mock("@cap/web-backend", () => ({
	Storage: { getAccessForVideo: mocks.access },
}));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
vi.mock("workflow/api", () => ({ start: mocks.start }));
vi.mock("@/workflows/edit-video", () => ({
	editVideoWorkflow: Object.assign(vi.fn(), { workflowId: "edit-workflow" }),
}));
vi.mock("@/lib/legacy-video-edit-recovery", () => ({
	assertLegacyEditsQuiescent: mocks.quiescent,
}));
vi.mock("@/lib/server", async () => ({
	runPromise: (await import("effect")).Effect.runPromise,
}));
vi.mock("@/lib/video-storage", () => ({
	decodeStorageVideo: (video: unknown) => video,
}));
vi.mock("@/lib/video-edit-operation", () => ({
	clearPendingEdit: mocks.clear,
}));
vi.mock("@/utils/flags", () => ({ isAiGenerationEnabled: async () => false }));

import {
	restoreVideoToOriginal,
	saveVideoEdits,
} from "@/actions/videos/save-edits";

const videoId = Video.VideoId.make("video");
const sourceKey = "owner/video/source/original.mp4";
const trim = {
	version: 1 as const,
	sourceDuration: 10,
	keepRanges: [{ start: 0, end: 5 }],
};

beforeEach(() => {
	vi.resetAllMocks();
	mocks.video = {
		id: videoId,
		ownerId: User.UserId.make("owner"),
		bucket: null,
		storageIntegrationId: null,
		source: { type: "webMP4" },
		duration: 10,
		metadata: null,
	};
	mocks.upload = undefined;
	mocks.edit = undefined;
	mocks.writes = [];
	mocks.auth.mockResolvedValue({ id: "owner", isPro: true });
	mocks.head.mockReturnValue(Effect.succeed({}));
	mocks.copy.mockReturnValue(Effect.void);
	mocks.access.mockReturnValue(
		Effect.succeed([
			{
				bucketName: "bucket",
				headObject: mocks.head,
				copyObject: mocks.copy,
				getInternalSignedObjectUrl: () =>
					Effect.succeed("https://storage.test/original.mp4"),
			},
		]),
	);
	mocks.fetch.mockResolvedValue(
		new Response(JSON.stringify({ metadata: { duration: 20 } }), {
			status: 200,
		}),
	);
	vi.stubGlobal("fetch", mocks.fetch);
});
afterEach(() => vi.unstubAllGlobals());

function legacyUpload() {
	mocks.upload = {
		videoId,
		rawFileKey: sourceKey,
		phase: "processing",
		startedAt: new Date("2026-09-01T00:00:00Z"),
		updatedAt: new Date("2026-09-01T01:00:00Z"),
	};
}

describe("video edit claims and recovery", () => {
	it("claims the recording before copying its original source", async () => {
		mocks.head.mockReturnValue(
			Effect.fail(Object.assign(new Error("Missing"), { name: "NotFound" })),
		);
		mocks.copy.mockImplementation(() => {
			expect(mocks.upload?.phase).toBe("processing");
			return Effect.void;
		});
		await saveVideoEdits(videoId, trim);
		expect(mocks.copy).toHaveBeenCalledOnce();
		expect(mocks.start).toHaveBeenCalledOnce();
	});
	it("releases a pending claim when the workflow start fails", async () => {
		mocks.start.mockRejectedValue(new Error("Enqueue failed"));
		await expect(saveVideoEdits(videoId, trim)).rejects.toThrow(
			"Enqueue failed",
		);
		expect(mocks.clear).toHaveBeenCalledWith(
			videoId,
			sourceKey,
			expect.objectContaining({ token: expect.any(String) }),
		);
	});
	it("preserves a legacy upload when recovery checks fail", async () => {
		legacyUpload();
		const upload = structuredClone(mocks.upload);
		mocks.quiescent.mockRejectedValue(new Error("Still running"));
		await expect(restoreVideoToOriginal(videoId)).rejects.toThrow(
			"Still running",
		);
		expect(mocks.upload).toEqual(upload);
		expect(mocks.writes).toEqual([]);
		expect(mocks.fetch).not.toHaveBeenCalled();
	});
	it("restores an interrupted first edit using the original duration even without an edit record", async () => {
		legacyUpload();
		await restoreVideoToOriginal(videoId);
		expect(mocks.quiescent).toHaveBeenCalledWith("edit-workflow");
		expect(mocks.writes).toEqual([
			"delete-upload",
			"insert-upload",
			"update-video",
		]);
		expect(mocks.start).toHaveBeenCalledWith(expect.any(Function), [
			expect.objectContaining({
				sourceKey,
				editSpec: {
					version: 1,
					sourceDuration: 20,
					keepRanges: [{ start: 0, end: 20 }],
				},
			}),
		]);
		expect(mocks.copy).not.toHaveBeenCalled();
	});
	it("refuses to replace a legacy row that changed during original verification", async () => {
		legacyUpload();
		mocks.fetch.mockImplementation(async () => {
			if (mocks.upload)
				mocks.upload.updatedAt = new Date("2026-09-08T00:00:00Z");
			return new Response(JSON.stringify({ metadata: { duration: 20 } }), {
				status: 200,
			});
		});
		await expect(restoreVideoToOriginal(videoId)).rejects.toThrow(
			"already uploading",
		);
		expect(mocks.writes).toEqual([]);
		expect(mocks.start).not.toHaveBeenCalled();
	});
	it("preserves recovery state when the original cannot be verified", async () => {
		legacyUpload();
		mocks.fetch.mockResolvedValue(
			new Response(JSON.stringify({ metadata: { duration: 0 } }), {
				status: 200,
			}),
		);
		await expect(restoreVideoToOriginal(videoId)).rejects.toThrow(
			"could not be verified",
		);
		expect(mocks.writes).toEqual([]);
	});
	it.each([
		[{ id: "other", isPro: true }, "Forbidden"],
		[{ id: "owner", isPro: false }, "Cap Pro"],
	] as const)(
		"requires the recording owner with edit access",
		async (user, message) => {
			legacyUpload();
			mocks.auth.mockResolvedValue(user);
			await expect(restoreVideoToOriginal(videoId)).rejects.toThrow(message);
			expect(mocks.quiescent).not.toHaveBeenCalled();
			expect(mocks.writes).toEqual([]);
		},
	);
	it("does not use legacy recovery to replace a current operation", async () => {
		legacyUpload();
		mocks.video.metadata = { editProcessing: { token: "current" } };
		await expect(restoreVideoToOriginal(videoId)).rejects.toThrow(
			"already uploading",
		);
		expect(mocks.quiescent).not.toHaveBeenCalled();
		expect(mocks.writes).toEqual([]);
	});
});
