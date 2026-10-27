import {
	claimAiGeneration,
	updateAiGenerationRun,
} from "@cap/database/cloudflare/ai-generation";
import { videos } from "@cap/database/cloudflare/schema";
import {
	metadataWithTranscriptPublication,
	prepareTranscriptPublication,
} from "@cap/database/cloudflare/transcript-publication";
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
	generate: vi.fn(),
	sync: vi.fn(),
}));
vi.mock("server-only", () => ({}));
vi.mock("@cap/database/cloudflare/application", () => ({
	db: () => state.database,
}));
vi.mock("@cap/web-backend/src/Storage/index", () => ({
	Storage: {
		getAccessForVideo: () =>
			Effect.succeed([
				{
					getObject: (key: string) =>
						Effect.succeed(Option.fromNullable(state.objects.get(key))),
				},
			]),
	},
}));
vi.mock("@/lib/workflow-runtime", () => ({
	runWorkflowPromise: Effect.runPromise,
}));
vi.mock("@/lib/video-storage", () => ({
	decodeStorageVideo: (value: unknown) => value,
}));
vi.mock("@/lib/ai/provider", () => ({ isAiConfigured: () => true }));
vi.mock("@/lib/ai/run", () => ({
	runWithAiProviders: (
		_operation: string,
		callback: (selection: unknown) => unknown,
	) => callback({ model: () => ({}), defaultMaxOutputTokens: 8000 }),
	AiUnavailableError: class AiUnavailableError extends Error {},
}));
vi.mock("ai", () => ({ generateText: state.generate }));
vi.mock("@/lib/sync-video-storage-names", () => ({
	enqueueVideoStorageNameSync: state.sync,
}));

import { generateAiWorkflow } from "@/workflows/generate-ai";

let fixture: Awaited<ReturnType<typeof createTestDatabase>>;
let video: typeof videos.$inferSelect;
const source =
	"WEBVTT\n\n1\n00:00:00.000 --> 00:00:05.000\nI explain how to review and approve this project.\n";
const store = {
	put: async (key: string, body: string) => {
		state.objects.set(key, body);
	},
	getText: async (key: string) => state.objects.get(key) ?? null,
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
async function claim() {
	const result = await claimAiGeneration(
		fixture.database,
		video.id,
		video.ownerId,
	);
	if (result.state !== "claimed") throw new Error("Claim missing");
	return result;
}

describe("AI publication on D1", () => {
	beforeAll(async () => {
		fixture = await createTestDatabase();
		state.database = fixture.database;
	});
	afterAll(async () => fixture.dispose());
	beforeEach(async () => {
		state.generate.mockReset().mockResolvedValue({
			text: JSON.stringify({
				title: "Project approval",
				summary: "I explain the project approval process.",
				chapters: [],
			}),
		});
		state.sync.mockReset().mockResolvedValue(undefined);
		state.objects.clear();
		const owner = await createTestOwner(fixture.database);
		const [row] = await fixture.database
			.insert(videos)
			.values({
				id: nanoId() as typeof videos.$inferInsert.id,
				ownerId: owner.id,
				orgId: owner.activeOrganizationId,
				name: "Untitled",
				source: { type: "desktopMP4" },
				duration: 10,
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
		await fixture.database
			.update(videos)
			.set({ metadata: metadataWithTranscriptPublication(row, prepared) })
			.where(eq(videos.id, row.id));
		video = {
			...row,
			metadata: metadataWithTranscriptPublication(row, prepared),
		};
	});
	it("allows only one concurrent dispatcher for a transcript revision", async () => {
		const results = await Promise.all(
			Array.from({ length: 5 }, () =>
				claimAiGeneration(fixture.database, video.id, video.ownerId),
			),
		);
		expect(results.filter((result) => result.state === "claimed")).toHaveLength(
			1,
		);
		expect(
			results.filter((result) => result.state === "in-progress"),
		).toHaveLength(4);
	});
	it("reclaims a stale claim only when no durable dispatch receipt exists", async () => {
		const first = await claim();
		await fixture.database
			.update(videos)
			.set({
				metadata: {
					...first.video.metadata,
					aiGenerationRun: {
						...first.run,
						requestedAt: "2020-01-01T00:00:00.000Z",
					},
				},
			})
			.where(eq(videos.id, video.id));
		const second = await claim();
		expect(second.run.id).not.toBe(first.run.id);
		await fixture.database
			.update(videos)
			.set({
				metadata: {
					...second.video.metadata,
					aiGenerationRun: {
						...second.run,
						requestedAt: "2020-01-01T00:00:00.000Z",
						workflowRunId: "durable-run",
						workflowQueue: "durable-queue",
						dispatch: "uncertain",
					},
				},
			})
			.where(eq(videos.id, video.id));
		expect(
			(await claimAiGeneration(fixture.database, video.id, video.ownerId))
				.state,
		).toBe("in-progress");
	});
	it("reads the published immutable transcript and saves title, summary, and chapters together", async () => {
		const run = await claim();
		await generateAiWorkflow({
			videoId: video.id,
			userId: video.ownerId,
			runId: run.run.id,
		});
		expect(await currentVideo()).toMatchObject({
			name: "Project approval",
			metadata: {
				aiGenerationStatus: "COMPLETE",
				summary: "I explain the project approval process.",
				chapters: [],
			},
		});
		expect(state.generate.mock.calls[0]?.[0].prompt).toContain(
			"I explain how to review and approve this project.",
		);
		expect(state.sync).toHaveBeenCalledTimes(1);
	});
	it("preserves manual title changes and intentional summary/chapter removals during generation", async () => {
		const run = await claim();
		state.generate.mockImplementationOnce(async () => {
			const current = await currentVideo();
			await fixture.database
				.update(videos)
				.set({
					name: "My chosen title",
					metadata: {
						...current.metadata,
						titleManuallyEdited: true,
						summary: "",
						summaryManuallyEdited: true,
						chapters: [],
						chaptersManuallyEdited: true,
					},
				})
				.where(eq(videos.id, video.id));
			return {
				text: JSON.stringify({
					title: "New AI title",
					summary: "Generated summary",
					chapters: [{ title: "Start", start: 0 }],
				}),
			};
		});
		await generateAiWorkflow({
			videoId: video.id,
			userId: video.ownerId,
			runId: run.run.id,
		});
		expect(await currentVideo()).toMatchObject({
			name: "My chosen title",
			metadata: { aiGenerationStatus: "COMPLETE", summary: "", chapters: [] },
		});
		expect(state.sync).not.toHaveBeenCalled();
	});
	it("does not publish results or old errors after a new transcript supersedes the job", async () => {
		const run = await claim();
		let newerRunId = "";
		state.generate.mockImplementationOnce(async () => {
			const current = await currentVideo();
			const prepared = await prepareTranscriptPublication({
				video: current,
				store,
				vtt: source.replace("review", "replace"),
				editTranscript: null,
			});
			await fixture.database
				.update(videos)
				.set({ metadata: metadataWithTranscriptPublication(current, prepared) })
				.where(eq(videos.id, video.id));
			const next = await claim();
			newerRunId = next.run.id;
			return {
				text: JSON.stringify({
					title: "Stale title",
					summary: "Stale summary",
					chapters: [],
				}),
			};
		});
		await generateAiWorkflow({
			videoId: video.id,
			userId: video.ownerId,
			runId: run.run.id,
		});
		expect(
			await updateAiGenerationRun(fixture.database, video.id, run.run.id, {
				status: "ERROR",
			}),
		).toBe(false);
		expect(await currentVideo()).toMatchObject({
			name: "Untitled",
			metadata: {
				aiGenerationStatus: "QUEUED",
				aiGenerationRun: { id: newerRunId },
			},
		});
		expect((await currentVideo()).metadata?.summary).toBeUndefined();
	});
	it("rejects another owner and refuses a stale run before calling the provider", async () => {
		expect(
			(await claimAiGeneration(fixture.database, video.id, "another-owner"))
				.state,
		).toBe("missing");
		const run = await claim();
		await fixture.database
			.update(videos)
			.set({ duration: 11 })
			.where(eq(videos.id, video.id));
		await expect(
			generateAiWorkflow({
				videoId: video.id,
				userId: video.ownerId,
				runId: run.run.id,
			}),
		).rejects.toThrow("superseded");
		expect(state.generate).not.toHaveBeenCalled();
		expect((await currentVideo()).metadata?.aiGenerationStatus).toBe("QUEUED");
	});
});
