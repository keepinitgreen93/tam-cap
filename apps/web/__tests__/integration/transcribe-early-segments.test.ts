import { randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { organizations, users, videos } from "@cap/database/cloudflare/schema";
import { getTranscriptObjectKey } from "@cap/database/cloudflare/transcript-publication";
import {
	claimTranscriptionRun,
	transcriptionAudioFilename,
} from "@cap/database/cloudflare/transcription-state";
import { eq } from "drizzle-orm";
import { Option } from "effect";
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
import { assemblyAIEditResponse } from "../fixtures/assemblyai-edit-response";

const mocks = vi.hoisted(() => ({
	transcribe: vi.fn(),
	putObject: vi.fn(),
	deleteObject: vi.fn(),
	getObject: vi.fn(),
	getInternalSignedObjectUrl: vi.fn(),
	startAiGeneration: vi.fn(),
	startWorkflow: vi.fn(),
	updates: [] as Record<string, unknown>[],
}));

const videoRow = vi.hoisted(() => ({
	id: "video-123",
	ownerId: "user-456",
	duration: null as number | null,
	settings: null,
	source: { type: "desktopSegments" },
	isScreenshot: false,
	transcriptionStatus: null,
	updatedAt: new Date("2026-08-01T00:00:00.000Z"),
	metadata: {},
}));

const state = vi.hoisted(() => ({
	editRows: [] as unknown[],
	fakeAudioPath: "",
	cloudflare: false,
	database: undefined as
		| Awaited<ReturnType<typeof createTestDatabase>>["database"]
		| undefined,
	objects: new Map<string, unknown>(),
	audioFilename: "",
}));

vi.mock("@cap/env", () => ({
	serverEnv: () => ({
		ASSEMBLY_API_KEY: "test-assembly-api-key",
		NEXTAUTH_SECRET: "test-secret-with-enough-entropy",
		...(state.cloudflare
			? {
					TRANSCRIPTION_PROVIDER: "cloudflare",
					CLOUDFLARE_ACCOUNT_ID: "0123456789abcdef0123456789abcdef",
					CLOUDFLARE_AI_API_TOKEN: "test-token",
				}
			: {}),
	}),
}));

vi.mock("@cap/database/cloudflare/application", () => ({
	db: () => state.database,
}));
vi.mock("@/lib/transcription-dispatch", () => ({
	dispatchTranscriptionRun: mocks.startWorkflow,
}));

vi.mock("server-only", () => ({}));

vi.mock("workflow", () => ({
	FatalError: class FatalError extends Error {},
}));

vi.mock("workflow/api", () => ({
	start: mocks.startWorkflow,
}));

vi.mock("assemblyai", () => ({
	AssemblyAI: class {
		transcripts = { transcribe: mocks.transcribe };
	},
}));

vi.mock("@cap/web-backend/src/Storage/index", () => ({
	Storage: {
		getAccessForVideo: () => ({
			pipe: (runner: (value: unknown) => unknown) =>
				runner([
					{
						putObject: mocks.putObject,
						deleteObject: mocks.deleteObject,
						getObject: mocks.getObject,
						getInternalSignedObjectUrl: mocks.getInternalSignedObjectUrl,
					},
				]),
		}),
	},
}));

vi.mock("@/lib/workflow-runtime", () => ({
	runWorkflowPromise: (value: unknown) => Promise.resolve(value),
}));

vi.mock("@/lib/video-storage", () => ({
	decodeStorageVideo: (video: unknown) => video,
}));

vi.mock("@/lib/media-client", () => ({
	isMediaServerConfigured: () => true,
	probeVideoViaMediaServer: async () => ({
		audioCodec: "aac",
		videoCodec: "h264",
		duration: 4,
		audioChannels: 2,
		sampleRate: 48_000,
	}),
	extractAudioViaMediaServer: async () => Buffer.from("audio"),
	checkHasAudioTrackViaMediaServer: async () => true,
}));

vi.mock("@/lib/audio-extract", () => ({
	checkHasAudioTrack: async () => true,
	extractAudioFromUrl: async () => ({
		filePath: state.fakeAudioPath,
		cleanup: async () => {},
	}),
}));

vi.mock("@/lib/audio-enhance", () => ({
	ENHANCED_AUDIO_CONTENT_TYPE: "audio/mpeg",
	ENHANCED_AUDIO_EXTENSION: "mp3",
	enhanceAudioFromUrl: async () => Buffer.from(""),
}));

vi.mock("@/lib/generate-ai", () => ({
	startAiGeneration: mocks.startAiGeneration,
}));

function pipeValue(value: unknown) {
	return { pipe: (runner: (input: unknown) => unknown) => runner(value) };
}

const manifest = {
	version: 5,
	video_init_uploaded: true,
	audio_init_uploaded: true,
	video_segments: [
		{ index: 1, duration: 2 },
		{ index: 2, duration: 2 },
	],
	audio_segments: [
		{ index: 1, duration: 2 },
		{ index: 2, duration: 2.5 },
	],
	is_complete: true,
};

let fixture: Awaited<ReturnType<typeof createTestDatabase>>;
beforeAll(async () => {
	fixture = await createTestDatabase();
	state.database = fixture.database;
	await fixture.database.insert(users).values({
		id: "user-456" as typeof users.$inferSelect.id,
		email: "segments-fixture@example.com",
		emailVerified: new Date(),
		activeOrganizationId: "org-123" as typeof organizations.$inferSelect.id,
	});
	await fixture.database.insert(organizations).values({
		id: "org-123" as typeof organizations.$inferSelect.id,
		name: "Segments fixture",
		ownerId: "user-456" as typeof users.$inferSelect.id,
	});
});
afterAll(async () => fixture.dispose());
async function currentVideo() {
	const [video] = await fixture.database
		.select()
		.from(videos)
		.where(eq(videos.id, "video-123" as typeof videos.$inferSelect.id));
	if (!video) throw new Error("Fixture missing");
	return video;
}
async function transcribeVideoWorkflow(payload: {
	videoId: string;
	userId: string;
	aiGenerationEnabled: boolean;
	earlyFromSegments?: boolean;
}) {
	await fixture.database
		.delete(videos)
		.where(eq(videos.id, "video-123" as typeof videos.$inferSelect.id));
	await fixture.database.insert(videos).values({
		id: "video-123" as typeof videos.$inferSelect.id,
		ownerId: "user-456" as typeof users.$inferSelect.id,
		orgId: "org-123" as typeof organizations.$inferSelect.id,
		name: "Segments",
		source: { type: "desktopSegments" },
		duration: videoRow.duration,
	});
	const claim = await claimTranscriptionRun(
		fixture.database,
		"video-123" as typeof videos.$inferSelect.id,
		"user-456" as typeof users.$inferSelect.id,
		{ earlyFromSegments: payload.earlyFromSegments },
	);
	if (!claim) throw new Error("Claim missing");
	state.audioFilename = transcriptionAudioFilename(claim.video);
	const workflow = await import("@/workflows/transcribe");
	return workflow.transcribeVideoWorkflow({
		...payload,
		runId: claim.video.metadata.transcriptionRun.id,
	});
}
async function artifactKey(kind: "edit" | "vtt") {
	return getTranscriptObjectKey(await currentVideo(), kind);
}

describe("transcribeVideoWorkflow earlyFromSegments", () => {
	beforeEach(async () => {
		mocks.updates.length = 0;
		state.editRows = [];
		videoRow.duration = null;
		videoRow.source = { type: "desktopSegments" };
		mocks.transcribe.mockReset();
		mocks.startWorkflow.mockReset();
		mocks.startWorkflow.mockResolvedValue(undefined);
		mocks.transcribe.mockResolvedValue({
			...assemblyAIEditResponse,
			audio_duration: 4,
		});
		mocks.putObject.mockImplementation((key: string, value: unknown) => {
			state.objects.set(key, value);
			return pipeValue(undefined);
		});
		mocks.deleteObject.mockImplementation(() => pipeValue(undefined));
		mocks.getObject.mockImplementation(() =>
			pipeValue(Option.some(JSON.stringify(manifest))),
		);
		mocks.getInternalSignedObjectUrl.mockImplementation((key: string) =>
			pipeValue(`https://storage.test/${key}`),
		);
		mocks.startAiGeneration.mockResolvedValue({ success: true, message: "ok" });

		state.fakeAudioPath = join(tmpdir(), `fake-audio-${randomUUID()}.mp3`);
		await fs.writeFile(state.fakeAudioPath, "mp3-bytes");

		vi.stubGlobal(
			"fetch",
			vi.fn(async (input: string | URL | Request) => {
				const url = String(input);
				if (url.includes("result.mp4") || url.includes("rawFileKey")) {
					return { ok: false, status: 404, statusText: "Not Found" };
				}
				return {
					ok: true,
					status: 200,
					statusText: "OK",
					arrayBuffer: async () => new TextEncoder().encode("seg").buffer,
				};
			}),
		);
	});

	it("transcribes straight from segment audio before any mux exists", async () => {
		const result = await transcribeVideoWorkflow({
			videoId: "video-123",
			userId: "user-456",
			aiGenerationEnabled: false,
			earlyFromSegments: true,
		});

		expect(result.success).toBe(true);
		expect(mocks.transcribe).toHaveBeenCalledTimes(1);

		const signedKeys = mocks.getInternalSignedObjectUrl.mock.calls.map(
			(call) => call[0],
		);
		expect(signedKeys).toContain("user-456/video-123/segments/audio/init.mp4");
		expect(signedKeys).toContain(
			"user-456/video-123/segments/audio/segment_001.m4s",
		);
		expect(signedKeys).toContain(
			"user-456/video-123/segments/audio/segment_002.m4s",
		);
		// never touches the video track
		expect(signedKeys.join()).not.toContain("segments/video");

		const writtenKeys = mocks.putObject.mock.calls.map((call) => call[0]);
		expect(writtenKeys).toContain(`user-456/video-123/${state.audioFilename}`);
		expect(writtenKeys).toContain(await artifactKey("vtt"));
		expect(writtenKeys).toContain(await artifactKey("edit"));

		// duration falls back to the manifest sum (2s + 2.5s) when the video row
		// has no duration yet (it is only set by the post-mux webhook)
		const { parseEditTranscript } = await import("@/lib/edit-transcript");
		const { decryptEditTranscriptObject } = await import(
			"@/lib/edit-transcript-storage"
		);
		const editKey = await artifactKey("edit");
		const write = mocks.putObject.mock.calls.find(
			(call) => call[0] === editKey,
		);
		const stored = parseEditTranscript(
			decryptEditTranscriptObject(
				write?.[1] as string,
				"user-456",
				"video-123",
			) ?? "",
		);
		expect(stored?.durationMs).toBe(4500);

		expect((await currentVideo()).transcriptionStatus).toBe("COMPLETE");
		expect((await currentVideo()).transcriptionStatus).not.toBe("ERROR");
	});

	it("defers back to the post-mux queue when the manifest is missing", async () => {
		mocks.getObject.mockImplementation(() => pipeValue(Option.none()));

		const result = await transcribeVideoWorkflow({
			videoId: "video-123",
			userId: "user-456",
			aiGenerationEnabled: false,
			earlyFromSegments: true,
		});

		expect(result.success).toBe(true);
		expect(result.message).toContain("deferred");
		expect(mocks.transcribe).not.toHaveBeenCalled();
		// the claim is released (PROCESSING -> null), never marked ERROR
		expect((await currentVideo()).transcriptionStatus).toBe("PROCESSING");
		expect((await currentVideo()).transcriptionStatus).not.toBe("ERROR");
		expect(mocks.updates).not.toContainEqual({
			transcriptionStatus: "COMPLETE",
		});
		// and the video is re-offered to the normal (non-early) path, because
		// the post-mux queue may already have run and been rejected by the claim
		expect(mocks.startWorkflow).toHaveBeenCalledTimes(1);
		expect(mocks.startWorkflow.mock.calls[0]?.[1]).toMatchObject({
			id: "video-123",
			ownerId: "user-456",
		});
		expect(mocks.startWorkflow.mock.calls[0]?.[3]).toBeUndefined();
	});

	it("defers when the manifest exists but is not complete", async () => {
		mocks.getObject.mockImplementation(() =>
			pipeValue(
				Option.some(JSON.stringify({ ...manifest, is_complete: false })),
			),
		);

		const result = await transcribeVideoWorkflow({
			videoId: "video-123",
			userId: "user-456",
			aiGenerationEnabled: false,
			earlyFromSegments: true,
		});

		expect(result.message).toContain("deferred");
		expect(mocks.transcribe).not.toHaveBeenCalled();
		expect((await currentVideo()).transcriptionStatus).toBe("PROCESSING");
	});

	it("marks NO_AUDIO when the completed manifest has no audio track", async () => {
		mocks.getObject.mockImplementation(() =>
			pipeValue(
				Option.some(
					JSON.stringify({
						...manifest,
						audio_init_uploaded: false,
						audio_segments: [],
					}),
				),
			),
		);

		const result = await transcribeVideoWorkflow({
			videoId: "video-123",
			userId: "user-456",
			aiGenerationEnabled: false,
			earlyFromSegments: true,
		});

		expect(result.success).toBe(true);
		expect(mocks.transcribe).not.toHaveBeenCalled();
		expect((await currentVideo()).transcriptionStatus).toBe("NO_AUDIO");
		expect((await currentVideo()).transcriptionStatus).not.toBe("ERROR");
	});

	it("preserves segment duration for Cloudflare when the normal path has no muxed source", async () => {
		state.cloudflare = true;
		const previousFetch = globalThis.fetch;
		vi.stubGlobal(
			"fetch",
			async (input: RequestInfo | URL, init?: RequestInit) => {
				if (String(input).startsWith("https://api.cloudflare.com/")) {
					return Response.json({
						success: true,
						result: {
							results: {
								channels: [
									{
										alternatives: [
											{
												transcript: "um hello",
												words: [
													{ word: "um", start: 0.1, end: 0.3 },
													{ word: "hello", start: 0.5, end: 1 },
												],
											},
										],
									},
								],
							},
						},
					});
				}
				return previousFetch(input, init);
			},
		);
		try {
			const result = await transcribeVideoWorkflow({
				videoId: "video-123",
				userId: "user-456",
				aiGenerationEnabled: false,
			});
			expect(result.success).toBe(true);
			const { decryptEditTranscriptObject } = await import(
				"@/lib/edit-transcript-storage"
			);
			const editKey = await artifactKey("edit");
			const write = mocks.putObject.mock.calls.find(
				(call) => call[0] === editKey,
			);
			const stored = JSON.parse(
				decryptEditTranscriptObject(
					write?.[1] as string,
					"user-456",
					"video-123",
				) ?? "{}",
			);
			expect(stored.durationMs).toBe(4500);
			expect(stored.words[0]).toMatchObject({
				text: "um",
				startMs: 100,
				endMs: 300,
			});
			expect(mocks.transcribe).not.toHaveBeenCalled();
		} finally {
			state.cloudflare = false;
		}
	});

	it("falls back to segment audio in the normal path when no muxed source exists", async () => {
		const result = await transcribeVideoWorkflow({
			videoId: "video-123",
			userId: "user-456",
			aiGenerationEnabled: false,
		});

		expect(result.success).toBe(true);
		expect(mocks.transcribe).toHaveBeenCalledTimes(1);
		const writtenKeys = mocks.putObject.mock.calls.map((call) => call[0]);
		expect(writtenKeys).toContain(await artifactKey("vtt"));
		expect((await currentVideo()).transcriptionStatus).toBe("COMPLETE");
		expect((await currentVideo()).transcriptionStatus).not.toBe("ERROR");
	});
});
