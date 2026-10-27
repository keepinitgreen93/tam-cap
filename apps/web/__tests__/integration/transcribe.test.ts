import {
	organizations,
	videos,
	videoUploads,
} from "@cap/database/cloudflare/schema";
import { claimTranscriptionRun } from "@cap/database/cloudflare/transcription-state";
import { nanoId } from "@cap/database/helpers";
import { eq } from "drizzle-orm";
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
	configured: true,
	start: vi.fn(),
	queue: vi.fn(),
	getRun: vi.fn(),
}));
vi.mock("@cap/database/cloudflare/application", () => ({
	db: () => state.database,
}));
vi.mock("@cap/env", () => ({
	serverEnv: () => ({
		ASSEMBLY_API_KEY: state.configured ? "synthetic-key" : undefined,
	}),
}));
vi.mock("@/workflows/transcribe", () => ({ transcribeVideoWorkflow: vi.fn() }));
vi.mock("workflow/api", () => ({ start: state.start, getRun: state.getRun }));
vi.mock("workflow/runtime", () => ({
	getWorld: () => ({ queue: state.queue }),
}));

import { transcribeVideo } from "@/lib/transcribe";

let fixture: Awaited<ReturnType<typeof createTestDatabase>>;
let video: typeof videos.$inferSelect;
async function currentVideo() {
	const [current] = await fixture.database
		.select()
		.from(videos)
		.where(eq(videos.id, video.id));
	if (!current) throw new Error("Fixture missing");
	return current;
}
const invoke = (ai = false, early = false) =>
	transcribeVideo(video.id, video.ownerId, ai, { earlyFromSegments: early });
describe("transcription dispatcher on D1", () => {
	beforeAll(async () => {
		fixture = await createTestDatabase();
		state.database = fixture.database;
	});
	afterAll(async () => fixture.dispose());
	afterEach(() => vi.unstubAllEnvs());
	beforeEach(async () => {
		vi.stubEnv("CAP_RUNTIME", "cloudflare");
		state.configured = true;
		const owner = await createTestOwner(fixture.database);
		const [row] = await fixture.database
			.insert(videos)
			.values({
				id: nanoId() as typeof videos.$inferInsert.id,
				ownerId: owner.id,
				orgId: owner.activeOrganizationId,
				name: "Dispatcher fixture",
				source: { type: "webMP4" },
				duration: 10,
			})
			.returning();
		if (!row) throw new Error("Fixture missing");
		video = row;
		state.queue.mockReset().mockResolvedValue(undefined);
		state.getRun.mockReset().mockReturnValue({
			exists: Promise.resolve(true),
			status: Promise.resolve("pending"),
		});
		state.start
			.mockReset()
			.mockImplementation(async (_workflow, _payload, options) => {
				await options.world.queue(
					"workflow-queue",
					{ runId: "durable-run" },
					{ deploymentId: "deployment" },
				);
				return { runId: "durable-run" };
			});
	});
	it("requires a transcription provider", async () => {
		state.configured = false;
		expect((await invoke()).success).toBe(false);
		expect(state.start).not.toHaveBeenCalled();
	});
	it.each([
		["", "owner"],
		["video", ""],
		["", ""],
	])("rejects empty identifiers %s %s", async (id, owner) => {
		expect((await transcribeVideo(id as typeof video.id, owner)).success).toBe(
			false,
		);
		expect(state.start).not.toHaveBeenCalled();
	});
	it("rejects missing videos and a different owner", async () => {
		expect(
			(await transcribeVideo("missing" as typeof video.id, video.ownerId))
				.success,
		).toBe(false);
		expect((await transcribeVideo(video.id, "other-owner")).success).toBe(
			false,
		);
		expect(state.start).not.toHaveBeenCalled();
	});
	it("skips video-disabled transcription within the atomic claim", async () => {
		await fixture.database
			.update(videos)
			.set({ settings: { disableTranscript: true } })
			.where(eq(videos.id, video.id));
		expect((await invoke()).success).toBe(true);
		expect((await currentVideo()).transcriptionStatus).toBe("SKIPPED");
		expect(state.start).not.toHaveBeenCalled();
	});
	it("honors organization defaults and video overrides", async () => {
		await fixture.database
			.update(organizations)
			.set({ settings: { disableTranscript: true } })
			.where(eq(organizations.id, video.orgId));
		await fixture.database
			.update(videos)
			.set({ settings: { disableTranscript: false } })
			.where(eq(videos.id, video.id));
		expect((await invoke()).success).toBe(true);
		expect(state.start).toHaveBeenCalledTimes(1);
	});
	it("skips an organization-disabled video without an override", async () => {
		await fixture.database
			.update(organizations)
			.set({ settings: { disableTranscript: true } })
			.where(eq(organizations.id, video.orgId));
		await invoke();
		expect((await currentVideo()).transcriptionStatus).toBe("SKIPPED");
		expect(state.start).not.toHaveBeenCalled();
	});
	it.each(["COMPLETE", "PROCESSING", "ERROR", "NO_AUDIO", "SKIPPED"] as const)(
		"does not overwrite terminal or active %s state",
		async (transcriptionStatus) => {
			await fixture.database
				.update(videos)
				.set({ transcriptionStatus, settings: { disableTranscript: true } })
				.where(eq(videos.id, video.id));
			await invoke();
			expect((await currentVideo()).transcriptionStatus).toBe(
				transcriptionStatus,
			);
			expect(state.start).not.toHaveBeenCalled();
		},
	);
	it("runs a verified full pass despite a fresh provisional live transcript", async () => {
		await fixture.database
			.update(videos)
			.set({
				metadata: {
					liveTranscript: {
						status: "active",
						updatedAt: new Date().toISOString(),
					},
				},
			})
			.where(eq(videos.id, video.id));
		expect((await invoke()).success).toBe(true);
		expect(state.start).toHaveBeenCalledTimes(1);
	});
	it.each(["uploading", "processing", "generating_thumbnail"] as const)(
		"defers normal transcription during %s",
		async (phase) => {
			await fixture.database
				.insert(videoUploads)
				.values({ videoId: video.id, phase });
			expect((await invoke()).success).toBe(true);
			expect(state.start).not.toHaveBeenCalled();
		},
	);
	it("permits the explicit early-segment path while the mux is processing", async () => {
		await fixture.database
			.insert(videoUploads)
			.values({ videoId: video.id, phase: "processing" });
		await invoke(false, true);
		expect(state.start).toHaveBeenCalledTimes(1);
		expect(state.start.mock.calls[0]?.[1][0]).toMatchObject({
			earlyFromSegments: true,
			aiGenerationEnabled: false,
		});
	});
	it("only dispatches once under concurrent callers and records the full durable receipt", async () => {
		const results = await Promise.all(
			Array.from({ length: 5 }, () => invoke(true)),
		);
		expect(results.every((result) => result.success)).toBe(true);
		expect(state.start).toHaveBeenCalledTimes(1);
		const current = await currentVideo();
		expect(current.metadata?.transcriptionRun).toMatchObject({
			dispatch: "accepted",
			workflowRunId: "durable-run",
			workflowQueue: "workflow-queue",
			deploymentId: "deployment",
		});
		expect(state.start.mock.calls[0]?.[1][0]).toMatchObject({
			videoId: video.id,
			userId: video.ownerId,
			runId: current.metadata?.transcriptionRun?.id,
			aiGenerationEnabled: true,
		});
	});
	it("releases a run rejected before queue delivery so it can be retried", async () => {
		state.start.mockRejectedValueOnce(new Error("serialization failed"));
		expect((await invoke()).success).toBe(false);
		expect((await currentVideo()).transcriptionStatus).toBeNull();
		expect((await invoke()).success).toBe(true);
	});
	it("retains and resumes an uncertain delivery without starting a duplicate", async () => {
		state.queue.mockRejectedValueOnce(new Error("acknowledgement lost"));
		expect((await invoke()).success).toBe(false);
		const first = await currentVideo();
		expect(first.metadata?.transcriptionRun?.dispatch).toBe("uncertain");
		await invoke();
		expect(state.start).toHaveBeenCalledTimes(1);
		expect(state.queue).toHaveBeenCalledTimes(2);
		expect((await currentVideo()).metadata?.transcriptionRun?.id).toBe(
			first.metadata?.transcriptionRun?.id,
		);
	});
	it("reclaims an abandoned pre-dispatch claim after its lease expires", async () => {
		const claim = await claimTranscriptionRun(
			fixture.database,
			video.id,
			video.ownerId,
		);
		if (!claim) throw new Error("Claim missing");
		await fixture.database
			.update(videos)
			.set({
				metadata: {
					...claim.video.metadata,
					transcriptionRun: {
						...claim.video.metadata.transcriptionRun,
						requestedAt: "2020-01-01T00:00:00.000Z",
					},
				},
			})
			.where(eq(videos.id, video.id));
		expect((await invoke()).success).toBe(true);
		expect(state.start).toHaveBeenCalledTimes(1);
		expect((await currentVideo()).metadata?.transcriptionRun?.id).not.toBe(
			claim.video.metadata.transcriptionRun.id,
		);
	});
});
