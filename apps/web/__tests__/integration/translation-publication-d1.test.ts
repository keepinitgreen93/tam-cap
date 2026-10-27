import { videos } from "@cap/database/cloudflare/schema";
import {
	createTranscriptInvalidation,
	metadataWithTranscriptPublication,
	prepareTranscriptPublication,
} from "@cap/database/cloudflare/transcript-publication";
import { nanoId } from "@cap/database/helpers";
import { eq } from "drizzle-orm";
import { Context, Effect, Option } from "effect";
import {
	afterAll,
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
	objects: new Map<string, string>(),
	generate: vi.fn(),
	allowed: true,
}));
vi.mock("server-only", () => ({}));
vi.mock("@cap/database/cloudflare/application", () => ({
	db: () => state.database,
}));
vi.mock("@cap/web-backend", () => {
	const tag = Context.GenericTag<{ canView: () => Effect.Effect<void, Error> }>(
		"TranslationPolicy",
	);
	return {
		VideosPolicy: tag,
		provideOptionalAuth: Effect.provideService(tag, {
			canView: () =>
				state.allowed ? Effect.void : Effect.fail(new Error("denied")),
		}),
		Storage: {
			getAccessForVideo: () =>
				Effect.succeed([
					{
						getObject: (key: string) =>
							Effect.succeed(Option.fromNullable(state.objects.get(key))),
						putObject: (key: string, body: string) =>
							Effect.sync(() => {
								state.objects.set(key, body);
							}),
						listObjects: ({ prefix }: { prefix: string }) =>
							Effect.succeed({
								Contents: [...state.objects.keys()]
									.filter((key) => key.startsWith(prefix))
									.map((Key) => ({ Key })),
							}),
					},
				]),
		},
	};
});
vi.mock("@/lib/server", () => ({
	runPromise: Effect.runPromise,
	runPromiseExit: Effect.runPromiseExit,
}));
vi.mock("@/lib/video-storage", () => ({
	decodeStorageVideo: (value: unknown) => value,
}));
vi.mock("@/lib/rate-limit", () => ({
	isRateLimited: async () => false,
	RATE_LIMIT_IDS: { TRANSLATE_TRANSCRIPT: "translation" },
}));
vi.mock("@/lib/ai/provider", () => ({ isAiConfigured: () => true }));
vi.mock("@/lib/ai/run", () => ({
	runWithAiProviders: (
		_operation: string,
		callback: (selection: unknown) => unknown,
	) => callback({ model: () => ({}), supportsTemperature: true }),
}));
vi.mock("ai", () => ({ generateText: state.generate }));

import { getAvailableTranslations } from "@/actions/videos/get-available-translations";
import { translateTranscript } from "@/actions/videos/translate-transcript";
import { withSourceFingerprint } from "@/actions/videos/translation-vtt";
import { translationCachePrefix } from "@/lib/translation-cache";

let fixture: Awaited<ReturnType<typeof createTestDatabase>>;
let video: typeof videos.$inferSelect;
const source =
	"WEBVTT\n\n1\n00:00:00.000 --> 00:00:05.000\nI review this project.";
const translated = source.replace(
	"I review this project.",
	"Reviso este proyecto.",
);
const store = {
	put: async (key: string, value: string) => {
		state.objects.set(key, value);
	},
	getText: async (key: string) => state.objects.get(key) ?? null,
	delete: async (key: string) => {
		state.objects.delete(key);
	},
};

describe("translation cache publications on D1", () => {
	beforeAll(async () => {
		fixture = await createTestDatabase();
		state.database = fixture.database;
	});
	afterAll(async () => fixture.dispose());
	beforeEach(async () => {
		state.objects.clear();
		state.allowed = true;
		state.generate
			.mockReset()
			.mockResolvedValue({ text: translated, finishReason: "stop" });
		const owner = await createTestOwner(fixture.database);
		const [row] = await fixture.database
			.insert(videos)
			.values({
				id: nanoId() as typeof videos.$inferInsert.id,
				ownerId: owner.id,
				orgId: owner.activeOrganizationId,
				name: "Transcript",
				source: { type: "webMP4" },
				transcriptionStatus: "COMPLETE",
			})
			.returning();
		if (!row) throw new Error("Fixture missing");
		const prepared = await prepareTranscriptPublication({
			video: row,
			store,
			vtt: source,
			editTranscript: null,
		});
		video = {
			...row,
			metadata: metadataWithTranscriptPublication(row, prepared),
		};
		await fixture.database
			.update(videos)
			.set({ metadata: video.metadata })
			.where(eq(videos.id, video.id));
	});
	it("reads current immutable VTT, ignores canonical translations, and lists only validated cache entries", async () => {
		state.objects.set(
			`${video.ownerId}/${video.id}/transcription.es.vtt`,
			translated,
		);
		expect(await getAvailableTranslations(video.id)).toMatchObject({
			success: true,
			hasOriginal: true,
			translations: [],
		});
		expect(await translateTranscript(video.id, "es")).toMatchObject({
			success: true,
			translatedVtt: translated,
		});
		expect(
			state.objects.has(`${translationCachePrefix(video, source)}es.vtt`),
		).toBe(true);
		expect(await getAvailableTranslations(video.id)).toMatchObject({
			success: true,
			translations: [{ code: "es" }],
		});
		await translateTranscript(video.id, "es");
		expect(state.generate).toHaveBeenCalledTimes(1);
	});
	it("does not list an older publication or a cache with the wrong source fingerprint", async () => {
		await translateTranscript(video.id, "es");
		state.objects.set(
			`${translationCachePrefix(video, source)}fr.vtt`,
			withSourceFingerprint(
				"WEBVTT\n\n1\n00:00:00.000 --> 00:00:05.000\nDifferent",
				translated,
			) ?? "invalid",
		);
		expect((await getAvailableTranslations(video.id)).translations).toEqual([
			{ code: "es", name: "Spanish" },
		]);
		const prepared = await prepareTranscriptPublication({
			video,
			store,
			vtt: source,
			editTranscript: null,
		});
		await fixture.database
			.update(videos)
			.set({ metadata: metadataWithTranscriptPublication(video, prepared) })
			.where(eq(videos.id, video.id));
		expect((await getAvailableTranslations(video.id)).translations).toEqual([]);
	});
	it("rejects output if the transcript changes during provider generation", async () => {
		state.generate.mockImplementationOnce(async () => {
			await fixture.database
				.update(videos)
				.set({
					metadata: {
						...video.metadata,
						transcriptPublication: createTranscriptInvalidation(),
					},
				})
				.where(eq(videos.id, video.id));
			return { text: translated, finishReason: "stop" };
		});
		expect(await translateTranscript(video.id, "es")).toMatchObject({
			success: false,
			message: "Transcript changed; retry translation",
		});
		expect(
			[...state.objects.keys()].some((key) => key.includes(".translations/")),
		).toBe(false);
	});
	it("enforces the view policy before any transcript read or translation", async () => {
		state.allowed = false;
		expect(await translateTranscript(video.id, "es")).toMatchObject({
			success: false,
		});
		expect(await getAvailableTranslations(video.id)).toMatchObject({
			success: false,
			translations: [],
		});
		expect(state.generate).not.toHaveBeenCalled();
	});
});
