vi.mock("server-only", () => ({}));

import { randomUUID } from "node:crypto";
import { createCloudflareDb } from "@cap/database/cloudflare";
import {
	claimAiGeneration,
	ownsAiGeneration,
} from "@cap/database/cloudflare/ai-generation";
import {
	createD1BridgeBinding,
	handleD1BridgeRequest,
} from "@cap/database/cloudflare/bridge";
import * as Db from "@cap/database/cloudflare/schema";
import {
	metadataWithTranscriptPublication,
	prepareTranscriptPublication,
	transcriptMediaRevision,
} from "@cap/database/cloudflare/transcript-publication";
import type { VideoMetadata } from "@cap/database/types";
import { Organisation, User, Video } from "@cap/web-domain";
import { eq } from "drizzle-orm";
import { Effect, Option } from "effect";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { createEditTranscript } from "@/lib/edit-transcript";
import { remapChaptersThroughEdit } from "@/lib/video-edits";
import { createTestDatabase } from "../../../../packages/database/cloudflare/test-runtime";

const state = vi.hoisted(() => ({
	database: undefined as ReturnType<typeof createCloudflareDb> | undefined,
	objects: new Map<string, string>(),
	copies: [] as string[],
}));
vi.mock("@cap/database/cloudflare/application", () => ({
	db: () => {
		if (!state.database) throw new Error("Missing cleanup database");
		return state.database;
	},
}));
vi.mock("@cap/env", () => ({
	serverEnv: () => ({
		NEXTAUTH_SECRET: "synthetic-cleanup-carry-secret",
		WEB_URL: "https://cap.test",
	}),
	buildEnv: { NEXT_PUBLIC_IS_CAP: false },
	NODE_ENV: "test",
}));
vi.mock("@/lib/workflow-runtime", () => ({
	runWorkflowPromise: Effect.runPromise,
}));
vi.mock("@/lib/server", () => ({ runPromise: Effect.runPromise }));
vi.mock("@/lib/transcribe", () => ({ transcribeVideo: vi.fn() }));
const bucket = {
	bucketName: "bucket",
	getObject: (key: string) =>
		Effect.succeed(Option.fromNullable(state.objects.get(key))),
	putObject: (key: string, value: string) =>
		Effect.sync(() => {
			state.objects.set(key, value);
		}),
	deleteObject: (key: string) => Effect.sync(() => state.objects.delete(key)),
	headObject: (key: string) =>
		state.objects.has(key)
			? Effect.succeed({})
			: Effect.fail({ _tag: "S3Error", cause: { name: "NotFound" } }),
	copyObject: (_source: string, key: string) =>
		Effect.sync(() => {
			state.copies.push(key);
			state.objects.set(key, "original");
		}),
};
vi.mock("@cap/web-backend/src/Storage/index", () => ({
	Storage: { getAccessForVideo: () => Effect.succeed([bucket]) },
}));
vi.mock("@cap/web-backend", () => ({
	Storage: { getAccessForVideo: () => Effect.succeed([bucket]) },
}));
vi.mock("@/lib/storage-not-found", () => ({
	isStorageObjectNotFound: () => true,
}));

import { clearFailedEdit } from "@/lib/video-edit-operation";
import { markEditProcessing } from "@/lib/video-edit-start";
import { saveEditResultAndComplete } from "@/workflows/edit-video";

let runtime: Awaited<ReturnType<typeof createTestDatabase>>;
beforeAll(async () => {
	runtime = await createTestDatabase();
	state.database = createCloudflareDb(
		createD1BridgeBinding({
			fetch: (request) => handleD1BridgeRequest(request, runtime.binding),
		}),
	);
}, 60000);
afterAll(async () => runtime?.dispose());

let sequence = 0;
const previousSpec = {
	version: 1 as const,
	sourceDuration: 100,
	keepRanges: [{ start: 0, end: 100 }],
};
// Removes 10s-20s and 50s-60s of a 100 second recording.
const editSpec = {
	version: 1 as const,
	sourceDuration: 100,
	keepRanges: [
		{ start: 0, end: 10 },
		{ start: 20, end: 50 },
		{ start: 60, end: 100 },
	],
};
const rendered = { duration: 80, width: 320, height: 180, fps: 30 };
const chapters = [
	{ title: "Intro", start: 0 },
	{ title: "Inside a removed pause", start: 15 },
	{ title: "Middle", start: 40 },
	{ title: "End", start: 90 },
];

async function readVideo(videoId: Video.VideoId) {
	const [video] = await runtime.database
		.select()
		.from(Db.videos)
		.where(eq(Db.videos.id, videoId));
	if (!video) throw new Error("Recording missing");
	return video;
}

/** A finalized, transcribed recording whose AI run has been claimed. */
async function fixture(aiGenerationStatus: "COMPLETE" | "PROCESSING") {
	const suffix = String(++sequence);
	const ownerId = User.UserId.make(`cowner${suffix}`);
	const orgId = Organisation.OrganisationId.make(`corg${suffix}`);
	const videoId = Video.VideoId.make(`cvideo${suffix}`);
	const outputKey = `${ownerId}/${videoId}/.recording/outputs/generation/attempt.mp4`;
	await runtime.database.insert(Db.users).values({
		id: ownerId,
		email: `${suffix}@cleanup.test`,
		activeOrganizationId: orgId,
	});
	await runtime.database
		.insert(Db.organizations)
		.values({ id: orgId, ownerId, name: "Cleanup team" });
	await runtime.database.insert(Db.videos).values({
		id: videoId,
		ownerId,
		orgId,
		name: "Display 2026-11-14 09.29 PM",
		source: { type: "desktopMP4", outputKey },
		duration: 100,
		width: 320,
		height: 180,
		transcriptionStatus: "COMPLETE",
		metadata: { sourceName: "Display 2026-11-14 09.29 PM" },
	});
	state.objects.set(outputKey, "original");
	// Published the way the transcription workflow publishes it.
	const transcribed = await readVideo(videoId);
	const prepared = await prepareTranscriptPublication({
		video: transcribed,
		store: {
			getText: async (key) => state.objects.get(key) ?? null,
			put: async (key, value) => {
				state.objects.set(key, value);
			},
			delete: async (key) => {
				state.objects.delete(key);
			},
		},
		vtt: "WEBVTT\n\n00:00:40.000 --> 00:00:40.500\nmiddle\n",
		editTranscript: JSON.stringify(
			createEditTranscript(
				{ words: [{ text: "middle", start: 40000, end: 40500 }] },
				100000,
			),
		),
	});
	await runtime.database
		.update(Db.videos)
		.set({ metadata: metadataWithTranscriptPublication(transcribed, prepared) })
		.where(eq(Db.videos.id, videoId));
	const claim = await claimAiGeneration(
		runtime.database as never,
		videoId,
		ownerId,
	);
	if (claim.state !== "claimed") throw new Error("AI run was not claimed");
	const claimed = await readVideo(videoId);
	const metadata: VideoMetadata = {
		...claimed.metadata,
		aiGenerationStatus,
		...(aiGenerationStatus === "COMPLETE"
			? {
					aiTitle: "Rebuilding My Website with AI",
					summary: "A walkthrough of the redesign.",
					chapters,
				}
			: {}),
	};
	await runtime.database
		.update(Db.videos)
		.set({
			metadata,
			...(aiGenerationStatus === "COMPLETE"
				? { name: "Rebuilding My Website with AI" }
				: {}),
		})
		.where(eq(Db.videos.id, videoId));
	return { ownerId, videoId, runId: claim.run.id };
}

async function startEdit(
	input: Awaited<ReturnType<typeof fixture>>,
	automatic: boolean,
) {
	const video = await readVideo(input.videoId);
	const requestId = randomUUID();
	const sourceKey = `${input.ownerId}/${input.videoId}/.recording/automatic-cleanup/${requestId}/original.mp4`;
	const operation = await markEditProcessing({
		video,
		sourceKey,
		previousSpec,
		...(automatic
			? {
					automaticCleanup: {
						version: 1 as const,
						requestId,
						transcriptId: video.metadata?.transcriptPublication?.id ?? "",
						status: "processing" as const,
						operation: {
							token: requestId,
							startedAt: new Date(
								Math.floor(Date.now() / 1000) * 1000,
							).toISOString(),
						},
						sourceKey,
						editSpec,
						fillerCount: 0,
						silenceCount: 2,
					},
				}
			: {}),
	});
	return { sourceKey, operation };
}

async function finishRender(videoId: Video.VideoId) {
	await runtime.database
		.update(Db.videoUploads)
		.set({ phase: "complete", processingProgress: 100 })
		.where(eq(Db.videoUploads.videoId, videoId));
}

describe("remapChaptersThroughEdit", () => {
	it("moves chapters onto the edited timeline", () => {
		expect(remapChaptersThroughEdit(chapters, editSpec)).toEqual([
			{ title: "Intro", start: 0 },
			// 15s was cut, so the chapter begins where the recording resumes.
			{ title: "Inside a removed pause", start: 10 },
			{ title: "Middle", start: 30 },
			{ title: "End", start: 70 },
		]);
	});
	it("keeps one chapter when a cut collapses two onto the same second", () => {
		expect(
			remapChaptersThroughEdit(
				[
					{ title: "First", start: 10 },
					{ title: "Second", start: 19 },
					{ title: "Third", start: 99.9 },
				],
				editSpec,
			),
		).toEqual([
			{ title: "First", start: 10 },
			{ title: "Third", start: 79 },
		]);
	});
	it("leaves chapters alone when nothing was removed", () => {
		expect(remapChaptersThroughEdit(chapters, previousSpec)).toEqual(chapters);
	});
});

describe("automatic cleanup keeps the early title", () => {
	it("keeps the AI run current while the cut renders", async () => {
		const input = await fixture("PROCESSING");
		expect(ownsAiGeneration(await readVideo(input.videoId), input.runId)).toBe(
			true,
		);
		await startEdit(input, true);
		const rendering = await readVideo(input.videoId);
		expect(rendering.metadata?.editProcessing).toBeDefined();
		// The title being written from this transcript can still be stored.
		expect(ownsAiGeneration(rendering, input.runId)).toBe(true);
	});

	it("still invalidates an AI run when the owner edits manually", async () => {
		const input = await fixture("PROCESSING");
		await startEdit(input, false);
		expect(ownsAiGeneration(await readVideo(input.videoId), input.runId)).toBe(
			false,
		);
	});

	it("publishes the cut with the title kept and chapters on the new timeline", async () => {
		const input = await fixture("COMPLETE");
		const edit = await startEdit(input, true);
		await finishRender(input.videoId);
		expect(
			await saveEditResultAndComplete(
				input.videoId,
				edit.sourceKey,
				previousSpec,
				editSpec,
				rendered,
				edit.operation,
			),
		).toEqual({ transcriptRemapped: true });
		const video = await readVideo(input.videoId);
		expect(video.duration).toBe(80);
		expect(video.name).toBe("Rebuilding My Website with AI");
		expect(video.metadata).toMatchObject({
			aiGenerationStatus: "COMPLETE",
			aiTitle: "Rebuilding My Website with AI",
			summary: "A walkthrough of the redesign.",
			chapters: [
				{ title: "Intro", start: 0 },
				{ title: "Inside a removed pause", start: 10 },
				{ title: "Middle", start: 30 },
				{ title: "End", start: 70 },
			],
		});
		expect(video.metadata?.editProcessing).toBeUndefined();
		expect(video.metadata?.completedVideoEdit?.token).toBe(
			edit.operation.token,
		);
		// Nothing is generated again: the run describes the finished recording.
		expect(video.metadata?.aiGenerationRun).toMatchObject({
			id: input.runId,
			mediaRevision: transcriptMediaRevision(video),
			transcriptId: video.metadata?.transcriptPublication?.id,
		});
		expect(
			(
				await claimAiGeneration(
					runtime.database as never,
					input.videoId,
					input.ownerId,
				)
			).state,
		).toBe("complete");
	});

	it("writes the title after the cut when it was not finished in time", async () => {
		const input = await fixture("PROCESSING");
		const edit = await startEdit(input, true);
		await finishRender(input.videoId);
		await saveEditResultAndComplete(
			input.videoId,
			edit.sourceKey,
			previousSpec,
			editSpec,
			rendered,
			edit.operation,
		);
		const video = await readVideo(input.videoId);
		expect(video.metadata?.aiGenerationStatus).toBeUndefined();
		expect(ownsAiGeneration(video, input.runId)).toBe(false);
		expect(
			(
				await claimAiGeneration(
					runtime.database as never,
					input.videoId,
					input.ownerId,
				)
			).state,
		).toBe("claimed");
	});

	it("clears the summary and chapters after a manual edit as before", async () => {
		const input = await fixture("COMPLETE");
		const edit = await startEdit(input, false);
		await finishRender(input.videoId);
		await saveEditResultAndComplete(
			input.videoId,
			edit.sourceKey,
			previousSpec,
			editSpec,
			rendered,
			edit.operation,
		);
		const video = await readVideo(input.videoId);
		expect(video.metadata?.aiGenerationStatus).toBeUndefined();
		expect(video.metadata?.summary).toBeUndefined();
		expect(video.metadata?.chapters).toBeUndefined();
	});

	it("keeps the title valid for the unchanged recording when the cut fails", async () => {
		const input = await fixture("COMPLETE");
		const edit = await startEdit(input, true);
		await clearFailedEdit(input.videoId, edit.sourceKey, edit.operation);
		const video = await readVideo(input.videoId);
		expect(video.metadata?.editProcessing).toBeUndefined();
		expect(video.metadata?.chapters).toEqual(chapters);
		expect(ownsAiGeneration(video, input.runId)).toBe(true);
		expect(
			(
				await claimAiGeneration(
					runtime.database as never,
					input.videoId,
					input.ownerId,
				)
			).state,
		).toBe("complete");
	});
});
