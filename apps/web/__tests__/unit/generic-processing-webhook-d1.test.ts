import { videos, videoUploads } from "@cap/database/cloudflare/schema";
import { nanoId } from "@cap/database/helpers";
import { Video } from "@cap/web-domain";
import { eq } from "drizzle-orm";
import { NextRequest } from "next/server";
import { afterAll, beforeAll, expect, it, vi } from "vitest";
import {
	claimVideoProcessing,
	updateProcessingDispatch,
} from "@/lib/video-processing-state";
import { createTestDatabase } from "../../../../packages/database/cloudflare/test-runtime";
import { createTestOwner } from "../helpers/cloudflare-team";

let fixture: Awaited<ReturnType<typeof createTestDatabase>>;
const transcription = vi.hoisted(() => vi.fn(async () => ({ success: true })));
vi.mock("server-only", () => ({}));
vi.mock("@cap/database/cloudflare/application", () => ({
	db: () => fixture.database,
}));
vi.mock("@cap/env", () => ({
	serverEnv: () => ({ MEDIA_SERVER_WEBHOOK_SECRET: "secret" }),
}));
vi.mock("@/lib/audio-level-publication", () => ({
	handleAudioLevelPublication: vi.fn(),
}));
vi.mock("@/lib/desktop-recording-jobs", () => ({
	SourceCommitPendingError: class extends Error {},
}));
vi.mock("@/lib/desktop-recording-publication", () => ({
	applyDesktopRecordingProgress: async () => ({ handled: false }),
}));
vi.mock("@/lib/desktop-recording-upload-status", () => ({
	createVerifiedRecordingReceipt: vi.fn(),
}));
vi.mock("@/lib/desktop-segments-finalization", () => ({
	queueDesktopSegmentsFinalization: vi.fn(),
}));
vi.mock("@/lib/google-drive-storage-quota", () => ({
	invalidateGoogleDriveStorageQuotaCache: vi.fn(),
}));
vi.mock("@/lib/loom-import-signal", () => ({
	signalLoomImportFinished: vi.fn(),
}));
vi.mock("@/lib/queue-video-transcription", () => ({
	queueVideoTranscription: transcription,
	shouldQueueTranscriptionAfterMediaComplete: () => true,
}));
vi.mock("@/lib/video-edit-progress", () => ({
	applyEditProgress: async () => false,
}));

import { POST } from "@/app/api/webhooks/media-server/progress/route";

beforeAll(async () => {
	fixture = await createTestDatabase();
});
afterAll(async () => fixture.dispose());
async function input() {
	const owner = await createTestOwner(fixture.database);
	const videoId = Video.VideoId.make(nanoId());
	const rawFileKey = `${owner.id}/${videoId}/raw.webm`;
	await fixture.database.batch([
		fixture.database.insert(videos).values({
			id: videoId,
			ownerId: owner.id,
			orgId: owner.activeOrganizationId,
			source: { type: "webMP4" },
		}),
		fixture.database
			.insert(videoUploads)
			.values({ videoId, rawFileKey, phase: "uploading", mode: "singlepart" }),
	]);
	return {
		videoId,
		userId: owner.id,
		rawFileKey,
		bucketId: null,
		processingMessage: "Start",
	};
}
async function complete(
	videoId: string,
	token: string,
	attemptId: string,
	secret = "secret",
	fps = 30,
) {
	return POST(
		new NextRequest(
			`http://localhost/api/webhooks/media-server/progress?processingRun=${token}&processingAttempt=${attemptId}`,
			{
				method: "POST",
				headers: {
					"Content-Type": "application/json",
					"x-media-server-secret": secret,
				},
				body: JSON.stringify({
					videoId,
					jobId: `process_${attemptId}`,
					phase: "complete",
					progress: 100,
					metadata: { width: 1920, height: 1080, fps, duration: 20 },
				}),
			},
		),
	);
}
it("publishes only the current attempt and invalidates old transcripts atomically", async () => {
	const value = await input();
	const first = await claimVideoProcessing(fixture.database, value);
	if (!first.run) throw new Error("Missing run");
	await updateProcessingDispatch(
		fixture.database,
		value.videoId,
		first.run.token,
		{ dispatch: "accepted" },
	);
	const [upload] = await fixture.database
		.select()
		.from(videoUploads)
		.where(eq(videoUploads.videoId, value.videoId));
	if (!upload) throw new Error("Missing upload");
	const current = await claimVideoProcessing(fixture.database, {
		...value,
		forceRestart: true,
		expectedUpdatedAt: upload.updatedAt,
		expectedProcessingToken: first.run.token,
	});
	if (!current.run) throw new Error("Missing run");
	expect(
		(await complete(value.videoId, first.run.token, first.run.attemptId))
			.status,
	).toBe(200);
	expect(transcription).not.toHaveBeenCalled();
	expect(
		(await complete(value.videoId, current.run.token, current.run.attemptId))
			.status,
	).toBe(200);
	const [video] = await fixture.database
		.select()
		.from(videos)
		.where(eq(videos.id, value.videoId));
	expect(video?.source).toMatchObject({ outputKey: current.run.outputKey });
	expect(video?.metadata?.transcriptPublication).toMatchObject({
		vtt: false,
		edit: false,
		revision: null,
	});
	expect(transcription).toHaveBeenCalledTimes(1);
	await complete(value.videoId, current.run.token, current.run.attemptId);
	expect(transcription).toHaveBeenCalledTimes(1);
});
it("rejects unauthenticated completion before publishing", async () => {
	const value = await input();
	const claimed = await claimVideoProcessing(fixture.database, value);
	if (!claimed.run) throw new Error("Missing run");
	expect(
		(
			await complete(
				value.videoId,
				claimed.run.token,
				claimed.run.attemptId,
				"wrong",
			)
		).status,
	).toBe(401);
	expect(
		(
			await fixture.database
				.select()
				.from(videos)
				.where(eq(videos.id, value.videoId))
		)[0]?.source,
	).toEqual({ type: "webMP4" });
});

it.each([25.06, 29.97])(
	"completes a generic processing callback with fractional fps %s on native D1",
	async (fps) => {
		const value = await input();
		const claimed = await claimVideoProcessing(fixture.database, value);
		if (!claimed.run) throw new Error("Missing processing run");
		await fixture.database
			.update(videoUploads)
			.set({ phase: "generating_thumbnail", processingProgress: 90 })
			.where(eq(videoUploads.videoId, value.videoId));
		const response = await complete(
			value.videoId,
			claimed.run.token,
			claimed.run.attemptId,
			"secret",
			fps,
		);
		expect(response.status).toBe(200);
		const [video] = await fixture.database
			.select()
			.from(videos)
			.where(eq(videos.id, value.videoId));
		const [upload] = await fixture.database
			.select()
			.from(videoUploads)
			.where(eq(videoUploads.videoId, value.videoId));
		expect(video).toMatchObject({
			fps: Math.round(fps),
			source: { outputKey: claimed.run.outputKey },
			duration: 20,
		});
		expect(upload?.phase).toBe("complete");
	},
);
