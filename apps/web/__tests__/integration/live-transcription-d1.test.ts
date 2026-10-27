import { randomUUID } from "node:crypto";
import { videos } from "@cap/database/cloudflare/schema";
import { nanoId } from "@cap/database/helpers";
import { eq } from "drizzle-orm";
import { Effect, Option } from "effect";
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
	transcribe: vi.fn(),
	fullPass: vi.fn(),
	put: vi.fn(),
}));
vi.mock("server-only", () => ({}));
vi.mock("@cap/database/cloudflare/application", () => ({
	db: () => state.database,
}));
vi.mock("@cap/env", () => ({
	serverEnv: () => ({
		TRANSCRIPTION_PROVIDER: "cloudflare",
		CLOUDFLARE_ACCOUNT_ID: "a".repeat(32),
		CLOUDFLARE_AI_API_TOKEN: "synthetic",
	}),
}));
vi.mock("@cap/web-backend/src/Storage/index", () => ({
	Storage: {
		getAccessForVideo: () =>
			Effect.succeed([
				{
					getObject: (key: string) =>
						Effect.succeed(Option.fromNullable(state.objects.get(key))),
					putObject: (key: string, body: string) =>
						Effect.sync(() => {
							state.put(key, body);
							state.objects.set(key, body);
						}),
					getInternalSignedObjectUrl: (key: string) =>
						Effect.succeed(`https://synthetic.example/${key}`),
				},
			]),
	},
}));
vi.mock("@/lib/workflow-runtime", () => ({
	runWorkflowPromise: Effect.runPromise,
}));
vi.mock("@/lib/video-storage", () => ({
	decodeStorageVideo: (video: unknown) => video,
}));
vi.mock("@/lib/segments-audio-download", () => ({
	downloadConcatenatedSegmentsToBuffer: async () =>
		Buffer.from("synthetic audio"),
}));
vi.mock("@/lib/transcription-provider", () => ({
	transcribeAudio: state.transcribe,
}));
vi.mock("@/lib/transcribe", () => ({ transcribeVideo: state.fullPass }));
vi.mock("@/lib/ai-generation-entitlement", () => ({
	isAiGenerationEnabledForUser: () => true,
}));

import {
	getLiveTranscriptObjectKey,
	parseLiveTranscript,
} from "@/lib/live-transcribe-core";
import { liveTranscribeWorkflow } from "@/workflows/live-transcribe";

let fixture: Awaited<ReturnType<typeof createTestDatabase>>;
let video: typeof videos.$inferSelect;
let runId: string;
const transcript = {
	status: "completed",
	language_code: "en",
	words: [
		{ text: "Hello", start: 100, end: 400, confidence: 1, speaker: null },
	],
};
async function currentVideo() {
	const [current] = await fixture.database
		.select()
		.from(videos)
		.where(eq(videos.id, video.id));
	if (!current) throw new Error("Fixture missing");
	return current;
}
const invoke = () =>
	liveTranscribeWorkflow({ videoId: video.id, userId: video.ownerId, runId });

describe("provisional live transcription on D1", () => {
	beforeAll(async () => {
		fixture = await createTestDatabase();
		state.database = fixture.database;
	});
	afterAll(async () => fixture.dispose());
	beforeEach(async () => {
		state.objects.clear();
		state.put.mockReset();
		state.transcribe.mockReset().mockResolvedValue(transcript);
		state.fullPass.mockReset().mockResolvedValue({ success: true });
		const owner = await createTestOwner(fixture.database);
		runId = randomUUID();
		const [row] = await fixture.database
			.insert(videos)
			.values({
				id: nanoId() as typeof videos.$inferInsert.id,
				ownerId: owner.id,
				orgId: owner.activeOrganizationId,
				name: "Live fixture",
				source: { type: "desktopSegments" },
				metadata: {
					liveTranscript: {
						id: runId,
						status: "active",
						updatedAt: new Date().toISOString(),
					},
				},
			})
			.returning();
		if (!row) throw new Error("Fixture missing");
		video = row;
		state.objects.set(
			`${video.ownerId}/${video.id}/segments/manifest.json`,
			JSON.stringify({
				version: 5,
				video_init_uploaded: true,
				audio_init_uploaded: true,
				video_segments: [{ index: 1, duration: 5 }],
				audio_segments: [{ index: 1, duration: 5 }],
				is_complete: true,
			}),
		);
	});
	it("keeps provisional artifacts scoped to the live run and queues a verified full pass", async () => {
		expect((await invoke()).success).toBe(true);
		const key = getLiveTranscriptObjectKey(video.ownerId, video.id, runId);
		expect(parseLiveTranscript(state.objects.get(key) ?? "")).toMatchObject({
			state: "complete",
			words: [{ text: "Hello" }],
		});
		expect(
			state.objects.has(`${video.ownerId}/${video.id}/transcription.vtt`),
		).toBe(false);
		expect(
			(await currentVideo()).metadata?.transcriptPublication,
		).toBeUndefined();
		expect((await currentVideo()).metadata?.liveTranscript).toMatchObject({
			id: runId,
			status: "complete",
		});
		expect(state.fullPass).toHaveBeenCalledWith(video.id, video.ownerId, true, {
			earlyFromSegments: true,
		});
	});
	it("does not write or finish a superseding live run after provider work returns", async () => {
		const newerId = randomUUID();
		state.transcribe.mockImplementationOnce(async () => {
			await fixture.database
				.update(videos)
				.set({
					metadata: { liveTranscript: { id: newerId, status: "active" } },
				})
				.where(eq(videos.id, video.id));
			return transcript;
		});
		await invoke();
		expect((await currentVideo()).metadata?.liveTranscript).toEqual({
			id: newerId,
			status: "active",
		});
		expect(state.put).not.toHaveBeenCalled();
		expect(state.fullPass).not.toHaveBeenCalled();
	});
	it("stops provisional work when the canonical transcript already exists", async () => {
		await fixture.database
			.update(videos)
			.set({ transcriptionStatus: "COMPLETE" })
			.where(eq(videos.id, video.id));
		expect((await invoke()).message).toContain(
			"canonical transcript already exists",
		);
		expect(state.transcribe).not.toHaveBeenCalled();
		expect(state.fullPass).not.toHaveBeenCalled();
		expect((await currentVideo()).transcriptionStatus).toBe("COMPLETE");
	});
});
