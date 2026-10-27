import { claimAiGeneration } from "@cap/database/cloudflare/ai-generation";
import {
	videoEdits,
	videos,
	videoUploads,
} from "@cap/database/cloudflare/schema";
import {
	getTranscriptObjectKey,
	metadataWithTranscriptPublication,
	prepareTranscriptPublication,
	readOriginalEditTranscript,
} from "@cap/database/cloudflare/transcript-publication";
import { nanoId } from "@cap/database/helpers";
import { eq } from "drizzle-orm";
import { Effect } from "effect";
import { NextRequest } from "next/server";
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
	user: vi.fn(),
	copy: vi.fn(),
	objects: new Map<string, string>(),
}));
vi.mock("server-only", () => ({}));
vi.mock("@cap/database/cloudflare/application", () => ({
	db: () => state.database,
}));
vi.mock("@cap/database/auth/session", () => ({ getCurrentUser: state.user }));
vi.mock("@cap/env", () => ({
	serverEnv: () => ({ NEXTAUTH_SECRET: "synthetic-reset-encryption-secret" }),
}));
vi.mock("@cap/web-backend", () => ({
	Storage: {
		getAccessForVideo: () =>
			Effect.succeed([
				{
					bucketName: "test-bucket",
					copyObject: (source: string, target: string) =>
						Effect.promise(async () => {
							await state.copy(source, target);
							const body = state.objects.get(
								source.replace(/^test-bucket\//, ""),
							);
							if (body === undefined) throw new Error("Source missing");
							state.objects.set(target, body);
						}),
				},
			]),
	},
}));
vi.mock("@/lib/server", () => ({ runPromise: Effect.runPromise }));
vi.mock("@/lib/video-storage", () => ({
	decodeStorageVideo: (video: unknown) => video,
}));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));

import { POST as reset } from "@/app/api/dev-reset-transcript/route";
import { POST as retry } from "@/app/api/videos/[videoId]/retry-transcription/route";

let fixture: Awaited<ReturnType<typeof createTestDatabase>>;
let video: typeof videos.$inferSelect;
const store = {
	getText: async (key: string) => state.objects.get(key) ?? null,
	put: async (key: string, body: string) => {
		state.objects.set(key, body);
	},
	delete: async (key: string) => {
		state.objects.delete(key);
	},
};
async function currentVideo() {
	const [current] = await fixture.database
		.select()
		.from(videos)
		.where(eq(videos.id, video.id));
	if (!current) throw new Error("Fixture missing");
	return current;
}
const request = (path: string) =>
	new NextRequest(`http://localhost:3000${path}`, {
		method: "POST",
		headers: { origin: "http://localhost:3000" },
	});
const retryRequest = () =>
	retry(request(`/api/videos/${video.id}/retry-transcription`), {
		params: Promise.resolve({ videoId: video.id }),
	});
const resetRequest = () =>
	reset(request(`/api/dev-reset-transcript?videoId=${video.id}`));

describe("transcript resets on D1", () => {
	beforeAll(async () => {
		fixture = await createTestDatabase();
		state.database = fixture.database;
	});
	afterAll(async () => fixture.dispose());
	afterEach(() => vi.unstubAllEnvs());
	beforeEach(async () => {
		vi.stubEnv("NODE_ENV", "development");
		state.copy.mockReset().mockResolvedValue(undefined);
		state.objects.clear();
		const owner = await createTestOwner(fixture.database);
		state.user.mockReset().mockResolvedValue(owner);
		const [row] = await fixture.database
			.insert(videos)
			.values({
				id: nanoId() as typeof videos.$inferInsert.id,
				ownerId: owner.id,
				orgId: owner.activeOrganizationId,
				name: "Reset fixture",
				source: { type: "webMP4" },
				duration: 5,
				transcriptionStatus: "COMPLETE",
			})
			.returning();
		if (!row) throw new Error("Fixture missing");
		const prepared = await prepareTranscriptPublication({
			video: row,
			store,
			vtt: "WEBVTT\n\noriginal captions",
			editTranscript: "original word timeline",
		});
		video = {
			...row,
			metadata: metadataWithTranscriptPublication(row, prepared),
		};
		await fixture.database
			.update(videos)
			.set({ metadata: video.metadata })
			.where(eq(videos.id, video.id));
		const originalKey = `${video.ownerId}/${video.id}/original.mp4`;
		state.objects.set(originalKey, "original media");
		await fixture.database.insert(videoEdits).values({
			videoId: video.id,
			sourceKey: originalKey,
			editSpec: {
				version: 1,
				sourceDuration: 10,
				keepRanges: [{ start: 0, end: 5 }],
			},
		});
	});
	it("retires generation jobs on retry while retaining the immutable original-word publication", async () => {
		await claimAiGeneration(fixture.database, video.id, video.ownerId);
		await fixture.database
			.update(videos)
			.set({ transcriptionStatus: "ERROR" })
			.where(eq(videos.id, video.id));
		expect((await retryRequest()).status).toBe(200);
		const current = await currentVideo();
		expect(current.transcriptionStatus).toBeNull();
		expect(current.metadata?.aiGenerationRun).toBeUndefined();
		expect(getTranscriptObjectKey(current, "edit")).toBe(
			getTranscriptObjectKey(video, "edit"),
		);
		expect(await readOriginalEditTranscript(current, store)).toBe(
			"original word timeline",
		);
		expect(state.copy).not.toHaveBeenCalled();
	});
	it("preserves source objects and restores the original to a unique output before atomic reset", async () => {
		await fixture.database
			.insert(videoUploads)
			.values({ videoId: video.id, phase: "complete" });
		const oldKeys = [...state.objects.keys()];
		expect((await resetRequest()).status).toBe(200);
		const current = await currentVideo();
		expect(current.duration).toBe(10);
		expect(current.transcriptionStatus).toBeNull();
		expect(current.source).toMatchObject({
			type: "desktopMP4",
			outputKey: expect.stringContaining("/.recording/reset/"),
		});
		expect(getTranscriptObjectKey(current, "vtt")).toBeNull();
		expect(oldKeys.every((key) => state.objects.has(key))).toBe(true);
		expect(
			await fixture.database
				.select()
				.from(videoEdits)
				.where(eq(videoEdits.videoId, video.id)),
		).toEqual([]);
		expect(
			await fixture.database
				.select()
				.from(videoUploads)
				.where(eq(videoUploads.videoId, video.id)),
		).toEqual([]);
	});
	it("rejects a source change made during the original-media copy", async () => {
		state.copy.mockImplementationOnce(async () => {
			await fixture.database
				.update(videos)
				.set({ duration: 6 })
				.where(eq(videos.id, video.id));
		});
		await expect(resetRequest()).rejects.toThrow("changed during reset");
		expect((await currentVideo()).duration).toBe(6);
		expect(getTranscriptObjectKey(await currentVideo(), "vtt")).toBe(
			getTranscriptObjectKey(video, "vtt"),
		);
		expect(
			await fixture.database
				.select()
				.from(videoEdits)
				.where(eq(videoEdits.videoId, video.id)),
		).toHaveLength(1);
	});
	it("denies another owner and keeps development reset closed in production", async () => {
		state.user.mockResolvedValue(await createTestOwner(fixture.database));
		expect((await retryRequest()).status).toBe(403);
		expect((await resetRequest()).status).toBe(404);
		vi.stubEnv("NODE_ENV", "production");
		expect((await resetRequest()).status).toBe(403);
		expect((await currentVideo()).transcriptionStatus).toBe("COMPLETE");
	});
});
