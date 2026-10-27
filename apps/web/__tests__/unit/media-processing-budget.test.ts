import * as Db from "@cap/database/cloudflare/schema";
import { Organisation, User, Video } from "@cap/web-domain";
import { afterAll, beforeAll, beforeEach, expect, it, vi } from "vitest";
import {
	getMediaProcessingReservation,
	RECORDING_PROCESSING_ATTEMPTS,
	reserveMediaProcessingBudget as reserveRaw,
} from "@/lib/media-processing-budget";
import { createTestDatabase } from "../../../../packages/database/cloudflare/test-runtime";

const state = vi.hoisted(() => ({
	database: undefined as
		| Awaited<ReturnType<typeof createTestDatabase>>["database"]
		| undefined,
}));
vi.mock("@cap/database/cloudflare/application", () => ({
	db: () => {
		if (!state.database) throw new Error("Missing budget database");
		return state.database;
	},
}));
let runtime: Awaited<ReturnType<typeof createTestDatabase>>;
const ownerId = User.UserId.make("budget-owner");
const orgId = Organisation.OrganisationId.make("budget-org");
beforeAll(async () => {
	runtime = await createTestDatabase();
	state.database = runtime.database;
	await runtime.database.insert(Db.users).values({
		id: ownerId,
		email: "budget@test.invalid",
		activeOrganizationId: orgId,
	});
	await runtime.database
		.insert(Db.organizations)
		.values({ id: orgId, ownerId, name: "Budgets" });
}, 60000);
afterAll(async () => runtime?.dispose());
beforeEach(async () => {
	await runtime.database.delete(Db.mediaProcessingBudgets);
	await runtime.database.delete(Db.videoProcessingJobs);
	await runtime.database.delete(Db.videos);
});
async function reserveMediaProcessingBudget(
	input: Parameters<typeof reserveRaw>[0],
) {
	const videoId = Video.VideoId.make(input.videoId);
	await runtime.database
		.insert(Db.videos)
		.values({
			id: videoId,
			ownerId,
			orgId,
			source: { type: "desktopSegments" },
		})
		.onConflictDoNothing();
	const job = {
		videoId,
		ownerId,
		generation: input.generation,
		attemptId: input.attemptId,
		state: "processing" as const,
		nextRetryAt: input.now ?? new Date(),
		leaseExpiresAt: new Date((input.now?.getTime() ?? Date.now()) + 60000),
	};
	await runtime.database
		.insert(Db.videoProcessingJobs)
		.values(job)
		.onConflictDoUpdate({ target: Db.videoProcessingJobs.videoId, set: job });
	return reserveRaw(input);
}

it("processes unrelated recordings regardless of the former daily allowance", async () => {
	vi.stubEnv("MEDIA_PROCESSING_DAILY_BUDGET_GIB", "1");
	try {
		for (let index = 0; index < 10; index++) {
			await expect(
				reserveMediaProcessingBudget({
					videoId: `video-${index}`,
					generation: "generation",
					attemptId: "attempt",
					sourceBytes: 1024 ** 3,
					now: new Date("2026-09-06T23:59:59Z"),
				}),
			).resolves.toBe(getMediaProcessingReservation(1024 ** 3).attemptBytes);
		}
		expect(
			await runtime.database.select().from(Db.mediaProcessingBudgets),
		).toHaveLength(20);
	} finally {
		vi.unstubAllEnvs();
	}
});

it("reuses an attempt reservation across dispatch retries and midnight", async () => {
	const input = {
		videoId: "video",
		generation: "generation",
		attemptId: "attempt",
		sourceBytes: 1024 ** 3,
	};
	const first = await reserveMediaProcessingBudget({
		...input,
		now: new Date("2026-09-06T23:59:59Z"),
	});
	for (let index = 0; index < 10; index++)
		expect(
			await reserveMediaProcessingBudget({
				...input,
				now: new Date("2026-09-07T00:00:01Z"),
			}),
		).toBe(first);
	expect(
		(await runtime.database.select().from(Db.mediaProcessingBudgets)).map(
			(row) => row.reservedBytes,
		),
	).toEqual([first, first]);
});

it("allows every automatic attempt before bounding repeated processing of the same source", async () => {
	const input = {
		videoId: "video",
		generation: "generation",
		sourceBytes: 1024 ** 3,
	};
	expect(RECORDING_PROCESSING_ATTEMPTS).toBe(5);
	for (let index = 0; index < RECORDING_PROCESSING_ATTEMPTS; index++)
		await reserveMediaProcessingBudget({
			...input,
			attemptId: `attempt-${index}`,
		});
	await expect(
		reserveMediaProcessingBudget({
			...input,
			attemptId: `attempt-${RECORDING_PROCESSING_ATTEMPTS}`,
		}),
	).rejects.toThrow("recording transfer budget exhausted");
});
