import { createCloudflareDb } from "@cap/database/cloudflare";
import { atomic } from "@cap/database/cloudflare/atomic";
import {
	createD1BridgeBinding,
	handleD1BridgeRequest,
} from "@cap/database/cloudflare/bridge";
import * as Db from "@cap/database/cloudflare/schema";
import { Comment, Organisation, User, Video } from "@cap/web-domain";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, expect, it, vi } from "vitest";
import { remapCommentTimestamps } from "@/lib/video-edit-comment-remap";
import { withEditOperation } from "@/lib/video-edit-operation";
import { applyEditProgress } from "@/lib/video-edit-progress";
import { createTestDatabase } from "../../../../packages/database/cloudflare/test-runtime";

const state = vi.hoisted(() => ({
	database: undefined as ReturnType<typeof createCloudflareDb> | undefined,
}));
vi.mock("@cap/database/cloudflare/application", () => ({
	db: () => {
		if (!state.database) throw new Error("D1 fixture unavailable");
		return state.database;
	},
}));

import {
	claimProcessingAttempt,
	ensureSegmentProcessingJob,
	initializeSourceCommitCheckpoint,
	markSourceBlocked,
	persistCommittedSource,
	persistSourceCommitCheckpoint,
	retryBlockedDesktopRecording,
	scheduleRetry,
} from "@/lib/desktop-recording-jobs";
import {
	getMediaProcessingReservation,
	recordingBudgetKey,
	reserveMediaProcessingBudget,
} from "@/lib/media-processing-budget";

let runtime: Awaited<ReturnType<typeof createTestDatabase>>;
let beforeBatch: (() => Promise<void>) | undefined;
let loseResponse = false;
const connect = () =>
	createCloudflareDb(
		createD1BridgeBinding({
			fetch: async (request) => {
				const payload = (await request.clone().json()) as { operation: string };
				if (payload.operation === "batch" && beforeBatch) {
					const hook = beforeBatch;
					beforeBatch = undefined;
					await hook();
				}
				const response = await handleD1BridgeRequest(request, runtime.binding);
				if (payload.operation === "batch" && loseResponse && response.ok) {
					loseResponse = false;
					throw new Error("Committed response lost");
				}
				return response;
			},
		}),
	);
beforeAll(async () => {
	runtime = await createTestDatabase();
	state.database = connect();
}, 60000);
afterAll(async () => runtime?.dispose());
let sequence = 0;
const verification = {
	version: 1 as const,
	artifact: { kind: "segments" as const, manifestSha256: "a".repeat(64) },
	requiredAudio: false,
};
const source = {
	version: 1 as const,
	kind: "segments" as const,
	manifestSha256: "a".repeat(64),
	inventorySha256: "b".repeat(64),
	inventoryKey: "owner/video/.recording/sources/retained/inventory.json",
	requiredAudio: false,
};
async function fixture() {
	const suffix = String(++sequence);
	const ownerId = User.UserId.make(`r-owner-${suffix}`);
	const orgId = Organisation.OrganisationId.make(`r-org-${suffix}`);
	const videoId = Video.VideoId.make(`r-video-${suffix}`);
	await runtime.database.insert(Db.users).values({
		id: ownerId,
		email: `${suffix}@recording.test`,
		activeOrganizationId: orgId,
	});
	await runtime.database
		.insert(Db.organizations)
		.values({ id: orgId, ownerId, name: "Recording team" });
	await runtime.database.insert(Db.videos).values({
		id: videoId,
		ownerId,
		orgId,
		source: { type: "desktopSegments" },
	});
	return { videoId, userId: ownerId, orgId, verification };
}
async function attemptFixture() {
	const input = await fixture();
	const { job } = await ensureSegmentProcessingJob(input);
	const attempt = await claimProcessingAttempt({
		videoId: input.videoId,
		generation: job.generation,
		attemptIdFor: (count) => `${job.generation}-${count}`,
	});
	if (!attempt) throw new Error("Attempt fixture was not claimed");
	return { ...input, attempt };
}

it("concurrent completion and claim requests retain one generation and one live owner", async () => {
	const input = await fixture();
	const results = await Promise.all(
		Array.from({ length: 5 }, () => ensureSegmentProcessingJob(input)),
	);
	expect(results.filter((result) => result.created)).toHaveLength(1);
	expect(new Set(results.map((result) => result.job.generation)).size).toBe(1);
	const generation = results[0]?.job.generation;
	if (!generation) throw new Error("Missing generation");
	const claims = await Promise.all(
		Array.from({ length: 5 }, () =>
			claimProcessingAttempt({ videoId: input.videoId, generation }),
		),
	);
	expect(claims.filter(Boolean)).toHaveLength(1);
});

it("database reconnection resumes the same named live attempt", async () => {
	const { videoId, attempt } = await attemptFixture();
	state.database = connect();
	const recovered = await claimProcessingAttempt({
		videoId,
		generation: attempt.generation,
		attemptIdFor: (count) => `${attempt.generation}-${count}`,
	});
	expect(recovered?.attemptId).toBe(attempt.attemptId);
	expect(recovered?.attemptCount).toBe(1);
});

it("budget retries after a committed lost response charge exactly once", async () => {
	const { videoId, attempt } = await attemptFixture();
	const input = {
		videoId,
		generation: attempt.generation,
		attemptId: attempt.attemptId,
		sourceBytes: 1024,
	};
	loseResponse = true;
	await expect(reserveMediaProcessingBudget(input)).rejects.toThrow(
		"Committed response lost",
	);
	state.database = connect();
	await Promise.all(
		Array.from({ length: 5 }, () => reserveMediaProcessingBudget(input)),
	);
	const [budget] = await runtime.database
		.select()
		.from(Db.mediaProcessingBudgets)
		.where(
			eq(
				Db.mediaProcessingBudgets.id,
				recordingBudgetKey(videoId, attempt.generation),
			),
		);
	expect(budget?.reservedBytes).toBe(
		getMediaProcessingReservation(1024).attemptBytes,
	);
});

it("concurrent audio processing reservations cannot exceed the recording budget", async () => {
	const { videoId } = await fixture();
	const settled = await Promise.allSettled(
		Array.from({ length: 6 }, (_, index) =>
			reserveMediaProcessingBudget({
				videoId,
				generation: "audio-test",
				attemptId: `audio-${index}`,
				sourceBytes: 1024,
				purpose: "audio-level",
			}),
		),
	);
	expect(
		settled.filter((result) => result.status === "fulfilled"),
	).toHaveLength(5);
	const [budget] = await runtime.database
		.select()
		.from(Db.mediaProcessingBudgets)
		.where(
			eq(
				Db.mediaProcessingBudgets.id,
				recordingBudgetKey(videoId, "audio-test"),
			),
		);
	expect(budget?.reservedBytes).toBe(budget?.limitBytes);
});

it("organization deletion between planning and commit denies the attempt", async () => {
	const input = await fixture();
	const { job } = await ensureSegmentProcessingJob(input);
	beforeBatch = async () => {
		await runtime.database
			.update(Db.organizations)
			.set({ tombstoneAt: new Date() })
			.where(eq(Db.organizations.id, input.orgId));
	};
	expect(
		await claimProcessingAttempt({
			videoId: input.videoId,
			generation: job.generation,
		}),
	).toBeNull();
	const [stored] = await runtime.database
		.select()
		.from(Db.videoProcessingJobs)
		.where(eq(Db.videoProcessingJobs.videoId, input.videoId));
	expect(stored?.attemptCount).toBe(0);
});

it("source checkpoint compare-and-swap rejects transferred ownership", async () => {
	const { videoId, attempt } = await attemptFixture();
	const checkpoint = await initializeSourceCommitCheckpoint(attempt);
	if (!checkpoint) throw new Error("Missing checkpoint");
	beforeBatch = async () => {
		await runtime.database
			.update(Db.videos)
			.set({ ownerId: User.UserId.make("new-owner") })
			.where(eq(Db.videos.id, videoId));
	};
	expect(
		await persistSourceCommitCheckpoint(attempt, {
			...checkpoint,
			revision: 1,
		}),
	).toBe(false);
	const [stored] = await runtime.database
		.select()
		.from(Db.videoProcessingJobs)
		.where(eq(Db.videoProcessingJobs.videoId, videoId));
	expect(stored?.output).toMatchObject({ revision: 0 });
});

it("operator retry rotates the generation and invalidates old attempts and receipts", async () => {
	const { videoId, attempt } = await attemptFixture();
	await persistCommittedSource(attempt, source);
	await reserveMediaProcessingBudget({
		videoId,
		generation: attempt.generation,
		attemptId: attempt.attemptId,
		sourceBytes: 1024,
	});
	await markSourceBlocked({
		...attempt,
		errorCode: "processing-budget-exhausted",
		errorMessage: "Fixture exhausted",
	});
	expect(await retryBlockedDesktopRecording({ videoId })).toMatchObject({
		status: "queued",
	});
	const [current] = await runtime.database
		.select()
		.from(Db.videoProcessingJobs)
		.where(eq(Db.videoProcessingJobs.videoId, videoId));
	if (!current) throw new Error("Missing retried job");
	expect(current.generation).not.toBe(attempt.generation);
	expect(current.source).toEqual(source);
	expect(
		await scheduleRetry({
			...attempt,
			errorCode: "old-worker",
			errorMessage: "Stale response",
		}),
	).toBe(false);
	const next = await claimProcessingAttempt({
		videoId,
		generation: current.generation,
		attemptIdFor: (count) => `${current.generation}-${count}`,
	});
	if (!next) throw new Error("Retry was not claimed");
	await reserveMediaProcessingBudget({
		videoId,
		generation: next.generation,
		attemptId: next.attemptId,
		sourceBytes: 1024,
	});
	const [budget] = await runtime.database
		.select()
		.from(Db.mediaProcessingBudgets)
		.where(
			eq(
				Db.mediaProcessingBudgets.id,
				recordingBudgetKey(videoId, next.generation),
			),
		);
	expect(budget?.reservedBytes).toBe(
		getMediaProcessingReservation(1024).attemptBytes,
	);
});

async function editFixture() {
	const input = await fixture();
	const operation = {
		token: "11111111-1111-4111-8111-111111111111",
		startedAt: new Date().toISOString(),
	};
	const sourceKey = `${input.userId}/${input.videoId}/source/original.mp4`;
	const metadata = {
		editProcessing: {
			...operation,
			ownerId: input.userId,
			bucket: null,
			storageIntegrationId: null,
			sourceKey,
			source: JSON.stringify({ type: "webMP4" }),
			dispatch: "pending" as const,
		},
	};
	await runtime.database
		.update(Db.videos)
		.set({ source: { type: "webMP4" }, metadata })
		.where(eq(Db.videos.id, input.videoId));
	await runtime.database.insert(Db.videoUploads).values({
		videoId: input.videoId,
		rawFileKey: sourceKey,
		startedAt: new Date(operation.startedAt),
		phase: "processing",
	});
	return { ...input, operation, sourceKey };
}

it("concurrent edit dispatchers obtain one atomic operation claim", async () => {
	const { videoId, operation, sourceKey } = await editFixture();
	const claim = () =>
		withEditOperation(
			videoId,
			sourceKey,
			operation,
			async (database, _snapshot, video, _upload, edit) => {
				if (edit.dispatch !== "pending")
					return { statements: [], result: false };
				return {
					statements: [
						database
							.update(Db.videos)
							.set({
								metadata: {
									...video.metadata,
									editProcessing: { ...edit, dispatch: "dispatching" },
								},
							})
							.where(eq(Db.videos.id, videoId)),
					],
					result: true,
				};
			},
		);
	expect((await Promise.all([claim(), claim()])).filter(Boolean)).toHaveLength(
		1,
	);
});

it("edit progress cannot publish after its organization is tombstoned", async () => {
	const { videoId, orgId, operation, sourceKey } = await editFixture();
	await withEditOperation(
		videoId,
		sourceKey,
		operation,
		async (database, _snapshot, video, _upload, edit) => ({
			statements: [
				database
					.update(Db.videos)
					.set({
						metadata: {
							...video.metadata,
							editProcessing: { ...edit, dispatch: "dispatching" },
						},
					})
					.where(eq(Db.videos.id, videoId)),
			],
			result: undefined,
		}),
	);
	beforeBatch = async () => {
		await runtime.database
			.update(Db.organizations)
			.set({ tombstoneAt: new Date() })
			.where(eq(Db.organizations.id, orgId));
	};
	await applyEditProgress(
		{
			videoId,
			jobId: "edit-worker",
			phase: "complete",
			progress: 100,
			metadata: { duration: 5, width: 320, height: 180, fps: 30 },
		},
		operation.token,
		operation.startedAt,
	);
	const [upload] = await runtime.database
		.select()
		.from(Db.videoUploads)
		.where(eq(Db.videoUploads.videoId, videoId));
	expect(upload?.phase).toBe("processing");
});

it("more than 100 comment timestamps remap in one atomic statement", async () => {
	const { videoId, userId } = await fixture();
	const changes = Array.from({ length: 150 }, (_, index) => ({
		id: Comment.CommentId.make(`rc${sequence}-${index}`),
		timestamp: index / 2,
	}));
	for (const change of changes)
		await runtime.database.insert(Db.comments).values({
			id: change.id,
			videoId,
			authorId: userId,
			content: "Timestamp",
			type: "text",
			timestamp: 999,
		});
	const updatedAt = new Date();
	await atomic(runtime.database, async () => ({
		statements: [
			remapCommentTimestamps(runtime.database, videoId, changes, updatedAt),
		],
		result: undefined,
	}));
	const result = await runtime.database
		.select()
		.from(Db.comments)
		.where(eq(Db.comments.videoId, videoId));
	expect(new Map(result.map((row) => [row.id, row.timestamp]))).toEqual(
		new Map(changes.map((row) => [row.id, row.timestamp])),
	);
});
