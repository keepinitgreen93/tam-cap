vi.mock("server-only", () => ({}));

import { randomUUID } from "node:crypto";
import { createCloudflareDb } from "@cap/database/cloudflare";
import {
	createD1BridgeBinding,
	handleD1BridgeRequest,
} from "@cap/database/cloudflare/bridge";
import * as Db from "@cap/database/cloudflare/schema";
import {
	createTranscriptInvalidation,
	getTranscriptObjectKey,
} from "@cap/database/cloudflare/transcript-publication";
import {
	decryptEditTranscriptObject,
	encryptEditTranscriptObject,
} from "@cap/database/transcript-encryption";
import { Comment, Organisation, User, Video } from "@cap/web-domain";
import { eq } from "drizzle-orm";
import { Effect, Option } from "effect";
import { afterAll, beforeAll, expect, it, vi } from "vitest";
import { createEditTranscript } from "@/lib/edit-transcript";
import { createTestDatabase } from "../../../../packages/database/cloudflare/test-runtime";

const state = vi.hoisted(() => ({
	database: undefined as ReturnType<typeof createCloudflareDb> | undefined,
	objects: new Map<string, string>(),
	writes: [] as string[],
}));
vi.mock("@cap/database/cloudflare/application", () => ({
	db: () => {
		if (!state.database) throw new Error("Missing edit database");
		return state.database;
	},
}));
vi.mock("@cap/env", () => ({
	serverEnv: () => ({
		NEXTAUTH_SECRET: "synthetic-edit-publication-secret",
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
vi.mock("@cap/web-backend/src/Storage/index", () => ({
	Storage: {
		getAccessForVideo: () =>
			Effect.succeed([
				{
					getObject: (key: string) =>
						Effect.succeed(Option.fromNullable(state.objects.get(key))),
					putObject: (key: string, value: string) =>
						Effect.sync(() => {
							state.writes.push(key);
							state.objects.set(key, value);
						}),
					deleteObject: (key: string) =>
						Effect.sync(() => state.objects.delete(key)),
				},
			]),
	},
}));

import { saveEditResultAndComplete } from "@/workflows/edit-video";

let runtime: Awaited<ReturnType<typeof createTestDatabase>>;
let beforeCommit: (() => Promise<void>) | undefined;
let loseCommit = false;
beforeAll(async () => {
	runtime = await createTestDatabase();
	state.database = createCloudflareDb(
		createD1BridgeBinding({
			fetch: async (request) => {
				const payload = (await request.clone().json()) as { operation: string };
				if (payload.operation === "batch" && beforeCommit) {
					const hook = beforeCommit;
					beforeCommit = undefined;
					await hook();
				}
				const response = await handleD1BridgeRequest(request, runtime.binding);
				if (payload.operation === "batch" && loseCommit && response.ok) {
					loseCommit = false;
					throw new Error("Edit publication response lost");
				}
				return response;
			},
		}),
	);
}, 60000);
afterAll(async () => runtime?.dispose());
let sequence = 0;
const previousSpec = {
	version: 1 as const,
	sourceDuration: 10,
	keepRanges: [{ start: 0, end: 10 }],
};
const editSpec = {
	version: 1 as const,
	sourceDuration: 10,
	keepRanges: [{ start: 5, end: 10 }],
};
const rendered = { duration: 5, width: 320, height: 180, fps: 30 };
async function fixture(withWords = true) {
	const suffix = String(++sequence);
	const ownerId = User.UserId.make(`eowner${suffix}`);
	const orgId = Organisation.OrganisationId.make(`eorg${suffix}`);
	const videoId = Video.VideoId.make(`evideo${suffix}`);
	const operation = {
		token: randomUUID(),
		startedAt: new Date().toISOString(),
	};
	const sourceKey = `${ownerId}/${videoId}/source/original.mp4`;
	await runtime.database.insert(Db.users).values({
		id: ownerId,
		email: `${suffix}@edit.test`,
		activeOrganizationId: orgId,
	});
	await runtime.database
		.insert(Db.organizations)
		.values({ id: orgId, ownerId, name: "Edit team" });
	await runtime.database.insert(Db.videos).values({
		id: videoId,
		ownerId,
		orgId,
		source: { type: "webMP4" },
		duration: 10,
		width: 320,
		height: 180,
		transcriptionStatus: "COMPLETE",
		metadata: {
			sourceName: "Preserved",
			editProcessing: {
				...operation,
				sourceKey,
				ownerId,
				bucket: null,
				storageIntegrationId: null,
				source: JSON.stringify({ type: "webMP4" }),
				dispatch: "accepted",
				jobId: "edit-worker",
			},
		},
	});
	await runtime.database.insert(Db.videoUploads).values({
		videoId,
		rawFileKey: sourceKey,
		startedAt: new Date(operation.startedAt),
		phase: "complete",
	});
	await runtime.database.insert(Db.comments).values({
		id: Comment.CommentId.make(`ecomment${suffix}`),
		videoId,
		authorId: ownerId,
		type: "text",
		content: "Retained",
		timestamp: 7,
	});
	const words = createEditTranscript(
		{ words: [{ text: "retained", start: 6000, end: 6500 }] },
		10000,
	);
	state.objects.set(
		`${ownerId}/${videoId}/transcription.vtt`,
		"WEBVTT\n\n00:00:06.000 --> 00:00:06.500\nretained\n",
	);
	if (withWords)
		state.objects.set(
			`${ownerId}/${videoId}/transcription.edit.v3.json`,
			encryptEditTranscriptObject(JSON.stringify(words), ownerId, videoId),
		);
	return { ownerId, videoId, operation, sourceKey, words };
}

it("lost edit commit responses preserve one paired publication and original word timing", async () => {
	const input = await fixture();
	const beforeWrites = state.writes.length;
	loseCommit = true;
	expect(
		await saveEditResultAndComplete(
			input.videoId,
			input.sourceKey,
			previousSpec,
			editSpec,
			rendered,
			input.operation,
		),
	).toEqual({ transcriptRemapped: true });
	const [video] = await runtime.database
		.select()
		.from(Db.videos)
		.where(eq(Db.videos.id, input.videoId));
	if (!video) throw new Error("Edited recording missing");
	expect(video.source).toMatchObject({
		outputKey: `${input.ownerId}/${input.videoId}/.recording/outputs/edit-${input.operation.token}/result.mp4`,
	});
	expect(video.metadata?.sourceName).toBe("Preserved");
	const editKey = getTranscriptObjectKey(video, "edit");
	const vttKey = getTranscriptObjectKey(video, "vtt");
	if (!editKey || !vttKey) throw new Error("Missing paired transcript pointer");
	expect(
		JSON.parse(
			decryptEditTranscriptObject(
				state.objects.get(editKey) ?? "",
				input.ownerId,
				input.videoId,
			) ?? "null",
		),
	).toEqual(input.words);
	expect(state.objects.get(vttKey)).toContain("00:00:01");
	expect(
		(
			await runtime.database
				.select()
				.from(Db.comments)
				.where(eq(Db.comments.videoId, input.videoId))
		)[0]?.timestamp,
	).toBe(2);
	expect(
		await runtime.database
			.select()
			.from(Db.videoUploads)
			.where(eq(Db.videoUploads.videoId, input.videoId)),
	).toHaveLength(0);
	expect(
		await saveEditResultAndComplete(
			input.videoId,
			input.sourceKey,
			previousSpec,
			editSpec,
			rendered,
			input.operation,
		),
	).toEqual({ transcriptRemapped: true });
	expect(state.writes.length - beforeWrites).toBe(2);
});

it("concurrent transcript replacement rolls back the media edit and its comment remap", async () => {
	const input = await fixture();
	const pointer = createTranscriptInvalidation();
	beforeCommit = async () => {
		const [video] = await runtime.database
			.select()
			.from(Db.videos)
			.where(eq(Db.videos.id, input.videoId));
		await runtime.database
			.update(Db.videos)
			.set({ metadata: { ...video?.metadata, transcriptPublication: pointer } })
			.where(eq(Db.videos.id, input.videoId));
	};
	await expect(
		saveEditResultAndComplete(
			input.videoId,
			input.sourceKey,
			previousSpec,
			editSpec,
			rendered,
			input.operation,
		),
	).rejects.toThrow("changed before publication");
	const [video] = await runtime.database
		.select()
		.from(Db.videos)
		.where(eq(Db.videos.id, input.videoId));
	expect(video?.source).toEqual({ type: "webMP4" });
	expect(video?.metadata?.transcriptPublication).toEqual(pointer);
	expect(
		(
			await runtime.database
				.select()
				.from(Db.comments)
				.where(eq(Db.comments.videoId, input.videoId))
		)[0]?.timestamp,
	).toBe(7);
	expect(
		[...state.objects.keys()].filter((key) =>
			key.startsWith(`${input.ownerId}/${input.videoId}/.transcripts/`),
		),
	).toHaveLength(0);
});

it("an edit without original words publishes an explicit invalidation without legacy fallback", async () => {
	const input = await fixture(false);
	expect(
		await saveEditResultAndComplete(
			input.videoId,
			input.sourceKey,
			previousSpec,
			editSpec,
			rendered,
			input.operation,
		),
	).toEqual({ transcriptRemapped: false });
	const [video] = await runtime.database
		.select()
		.from(Db.videos)
		.where(eq(Db.videos.id, input.videoId));
	if (!video) throw new Error("Edited recording missing");
	expect(video.transcriptionStatus).toBeNull();
	expect(getTranscriptObjectKey(video, "vtt")).toBeNull();
	expect(
		state.objects.has(`${input.ownerId}/${input.videoId}/transcription.vtt`),
	).toBe(true);
});
