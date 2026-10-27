import {
	organizations,
	videos,
	videoUploads,
} from "@cap/database/cloudflare/schema";
import { nanoId } from "@cap/database/helpers";
import { Video } from "@cap/web-domain";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, expect, it } from "vitest";
import {
	applyVideoProcessingProgress,
	claimProcessingAttempt,
	claimVideoProcessing,
	updateProcessingDispatch,
} from "@/lib/video-processing-state";
import { createTestDatabase } from "../../../../packages/database/cloudflare/test-runtime";
import { createTestOwner } from "../helpers/cloudflare-team";

let fixture: Awaited<ReturnType<typeof createTestDatabase>>;
beforeAll(async () => {
	fixture = await createTestDatabase();
});
afterAll(async () => fixture.dispose());
async function input() {
	const owner = await createTestOwner(fixture.database);
	const videoId = Video.VideoId.make(nanoId());
	const rawFileKey = `${owner.id}/${videoId}/raw-upload.webm`;
	await fixture.database.batch([
		fixture.database.insert(videos).values({
			id: videoId,
			ownerId: owner.id,
			orgId: owner.activeOrganizationId,
			name: "Processing",
			source: { type: "webMP4" },
		}),
		fixture.database
			.insert(videoUploads)
			.values({ videoId, phase: "uploading", mode: "singlepart", rawFileKey }),
	]);
	return {
		videoId,
		userId: owner.id,
		rawFileKey,
		bucketId: null,
		processingMessage: "Starting",
		organizationId: owner.activeOrganizationId,
	};
}
const metadata = { duration: 10, width: 1920, height: 1080, fps: 30 };

it("claims one processing run for concurrent upload completion requests", async () => {
	const value = await input();
	const results = await Promise.all([
		claimVideoProcessing(fixture.database, value),
		claimVideoProcessing(fixture.database, value),
	]);
	expect(results.filter((result) => result.dispatch)).toHaveLength(1);
	const run = results.find((result) => result.dispatch)?.run;
	expect(run?.outputKey).toContain(
		`/.recording/outputs/process-${run?.token}/`,
	);
	expect(run?.rawFileKey).toBe(value.rawFileKey);
});

it("fences stale worker completion after a concurrent forced restart", async () => {
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
	const restarted = await Promise.all([
		claimVideoProcessing(fixture.database, {
			...value,
			forceRestart: true,
			expectedUpdatedAt: upload.updatedAt,
			expectedProcessingToken: first.run.token,
		}),
		claimVideoProcessing(fixture.database, {
			...value,
			forceRestart: true,
			expectedUpdatedAt: upload.updatedAt,
			expectedProcessingToken: first.run.token,
		}),
	]);
	expect(restarted.filter((result) => result.dispatch)).toHaveLength(1);
	const current = restarted.find((result) => result.dispatch)?.run;
	if (!current) throw new Error("Missing restart");
	expect(
		await applyVideoProcessingProgress(fixture.database, {
			videoId: value.videoId,
			token: first.run.token,
			attemptId: first.run.attemptId,
			phase: "complete",
			progress: 100,
			metadata,
		}),
	).toBe(false);
	expect(
		await applyVideoProcessingProgress(fixture.database, {
			videoId: value.videoId,
			token: current.token,
			attemptId: current.attemptId,
			phase: "complete",
			progress: 100,
			metadata,
		}),
	).toBe(true);
	const [video] = await fixture.database
		.select()
		.from(videos)
		.where(eq(videos.id, value.videoId));
	expect(video?.source).toMatchObject({ outputKey: current.outputKey });
	expect(video?.metadata?.processingRun?.rawFileKey).toBe(value.rawFileKey);
	expect((await claimVideoProcessing(fixture.database, value)).status).toBe(
		"already-complete",
	);
});

it("rotates failed attempts without accepting older progress", async () => {
	const value = await input();
	const claimed = await claimVideoProcessing(fixture.database, value);
	if (!claimed.run) throw new Error("Missing run");
	const run = claimed.run;
	await applyVideoProcessingProgress(fixture.database, {
		videoId: value.videoId,
		token: run.token,
		attemptId: run.attemptId,
		phase: "error",
		progress: 10,
		error: "Worker restarted",
	});
	const next = await claimProcessingAttempt(
		fixture.database,
		value.videoId,
		run.token,
		1,
	);
	expect(next.attemptId).not.toBe(run.attemptId);
	expect(next.outputKey).not.toBe(run.outputKey);
	expect(
		await applyVideoProcessingProgress(fixture.database, {
			videoId: value.videoId,
			token: run.token,
			attemptId: run.attemptId,
			phase: "complete",
			progress: 100,
			metadata,
		}),
	).toBe(false);
	expect(
		await applyVideoProcessingProgress(fixture.database, {
			videoId: value.videoId,
			token: run.token,
			attemptId: next.attemptId,
			phase: "complete",
			progress: 100,
			metadata,
		}),
	).toBe(true);
});

it("rejects changed source identity and an inactive organization", async () => {
	const value = await input();
	const claimed = await claimVideoProcessing(fixture.database, value);
	if (!claimed.run) throw new Error("Missing run");
	const run = claimed.run;
	await fixture.database
		.update(videos)
		.set({ source: { type: "local" } })
		.where(eq(videos.id, value.videoId));
	expect(
		await applyVideoProcessingProgress(fixture.database, {
			videoId: value.videoId,
			token: run.token,
			attemptId: run.attemptId,
			phase: "complete",
			progress: 100,
			metadata,
		}),
	).toBe(false);
	await fixture.database
		.update(videos)
		.set({ source: { type: "webMP4" } })
		.where(eq(videos.id, value.videoId));
	await fixture.database
		.update(organizations)
		.set({ tombstoneAt: new Date() })
		.where(eq(organizations.id, value.organizationId));
	await expect(
		applyVideoProcessingProgress(fixture.database, {
			videoId: value.videoId,
			token: run.token,
			attemptId: run.attemptId,
			phase: "complete",
			progress: 100,
			metadata,
		}),
	).rejects.toThrow();
});

it("rolls back source publication if the upload completion update fails", async () => {
	const value = await input();
	const claimed = await claimVideoProcessing(fixture.database, value);
	if (!claimed.run) throw new Error("Missing run");
	await fixture.binding
		.prepare(
			"CREATE TRIGGER reject_upload_complete BEFORE UPDATE ON video_uploads WHEN NEW.phase = 'complete' BEGIN SELECT RAISE(ABORT, 'reject completion'); END",
		)
		.run();
	try {
		await expect(
			applyVideoProcessingProgress(fixture.database, {
				videoId: value.videoId,
				token: claimed.run.token,
				attemptId: claimed.run.attemptId,
				phase: "complete",
				progress: 100,
				metadata,
			}),
		).rejects.toThrow();
		expect(
			(
				await fixture.database
					.select()
					.from(videos)
					.where(eq(videos.id, value.videoId))
			)[0]?.source,
		).toEqual({ type: "webMP4" });
	} finally {
		await fixture.binding.prepare("DROP TRIGGER reject_upload_complete").run();
	}
});
