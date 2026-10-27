import {
	developerApps,
	developerCreditAccounts,
	developerCreditTransactions,
	developerDailyStorageSnapshots,
	developerVideos,
} from "@cap/database/cloudflare/schema";
import { nanoId } from "@cap/database/helpers";
import { eq } from "drizzle-orm";
import {
	afterAll,
	beforeAll,
	beforeEach,
	describe,
	expect,
	it,
	vi,
} from "vitest";
import { createTestDatabase } from "../../../../packages/database/cloudflare/test-runtime";
import { createTestOwner } from "../helpers/cloudflare-team";

let fixture: Awaited<ReturnType<typeof createTestDatabase>>;
const environment = vi.hoisted(() => ({ NEXT_PUBLIC_IS_CAP: "true" }));
vi.mock("@cap/env", () => ({ buildEnv: environment }));
vi.mock("@cap/database/cloudflare/application", () => ({
	db: () => fixture.database,
}));

import { GET } from "@/app/api/cron/developer-storage/route";

beforeAll(async () => {
	fixture = await createTestDatabase();
});
afterAll(async () => {
	await fixture.dispose();
	vi.unstubAllEnvs();
});
beforeEach(async () => {
	vi.stubEnv("CRON_SECRET", "test-secret");
	environment.NEXT_PUBLIC_IS_CAP = "true";
	await fixture.database.update(developerApps).set({ deletedAt: new Date() });
});
const request = (secret = "test-secret") =>
	new Request("http://localhost/api/cron/developer-storage", {
		headers: { authorization: `Bearer ${secret}` },
	});
async function app(minutes = 100, balance = 10000) {
	const owner = await createTestOwner(fixture.database);
	const appId = nanoId();
	const accountId = nanoId();
	await fixture.database.batch([
		fixture.database
			.insert(developerApps)
			.values({
				id: appId,
				ownerId: owner.id,
				name: "Metered",
				environment: "development",
			}),
		fixture.database
			.insert(developerCreditAccounts)
			.values({
				id: accountId,
				appId,
				ownerId: owner.id,
				balanceMicroCredits: balance,
			}),
		fixture.database
			.insert(developerVideos)
			.values({ id: nanoId(), appId, duration: minutes * 60 }),
	]);
	return { appId, accountId };
}

describe("developer daily usage on D1", () => {
	it("returns 401 when no auth header", async () => {
		expect((await GET(new Request("http://localhost"))).status).toBe(401);
	});
	it("returns 401 when the bearer token is wrong", async () => {
		expect((await GET(request("wrong"))).status).toBe(401);
	});
	it("processes apps and creates a negative storage_daily transaction", async () => {
		const value = await app();
		const response = await GET(request());
		expect(await response.json()).toMatchObject({
			success: true,
			appsProcessed: 1,
			date: new Date().toISOString().slice(0, 10),
		});
		expect(
			(
				await fixture.database
					.select()
					.from(developerCreditAccounts)
					.where(eq(developerCreditAccounts.id, value.accountId))
			)[0]?.balanceMicroCredits,
		).toBe(9667);
		expect(
			(
				await fixture.database
					.select()
					.from(developerCreditTransactions)
					.where(eq(developerCreditTransactions.accountId, value.accountId))
			)[0],
		).toMatchObject({ type: "storage_daily", amountMicroCredits: -333 });
	});
	it("deduplicates concurrent and repeated daily snapshots", async () => {
		const value = await app();
		const results = await Promise.all([GET(request()), GET(request())]);
		const bodies = await Promise.all(
			results.map((response) => response.json()),
		);
		expect(bodies.reduce((count, body) => count + body.appsProcessed, 0)).toBe(
			1,
		);
		expect((await GET(request())).status).toBe(200);
		expect(
			await fixture.database
				.select()
				.from(developerDailyStorageSnapshots)
				.where(eq(developerDailyStorageSnapshots.appId, value.appId)),
		).toHaveLength(1);
		expect(
			await fixture.database
				.select()
				.from(developerCreditTransactions)
				.where(eq(developerCreditTransactions.accountId, value.accountId)),
		).toHaveLength(1);
	});
	it("skips zero duration", async () => {
		await app(0);
		expect(await (await GET(request())).json()).toMatchObject({
			appsProcessed: 0,
		});
	});
	it("skips apps without a credit account", async () => {
		const value = await app();
		await fixture.database
			.delete(developerCreditAccounts)
			.where(eq(developerCreditAccounts.id, value.accountId));
		expect(await (await GET(request())).json()).toMatchObject({
			appsProcessed: 0,
		});
	});
	it("does not count insufficient balance as processed", async () => {
		const value = await app(100, 1);
		expect(await (await GET(request())).json()).toMatchObject({
			appsProcessed: 0,
		});
		expect(
			await fixture.database
				.select()
				.from(developerDailyStorageSnapshots)
				.where(eq(developerDailyStorageSnapshots.appId, value.appId)),
		).toHaveLength(0);
	});
	it("records self-hosted usage without a Cap Cloud charge", async () => {
		environment.NEXT_PUBLIC_IS_CAP = "false";
		const value = await app(100, 0);
		expect(await (await GET(request())).json()).toMatchObject({
			appsProcessed: 1,
		});
		expect(
			(
				await fixture.database
					.select()
					.from(developerDailyStorageSnapshots)
					.where(eq(developerDailyStorageSnapshots.appId, value.appId))
			)[0]?.microCreditsCharged,
		).toBe(0);
	});
	it("rolls back the debit and receipt if the snapshot fails", async () => {
		const value = await app();
		await fixture.binding
			.prepare(
				"CREATE TRIGGER reject_snapshot BEFORE INSERT ON developer_daily_storage_snapshots BEGIN SELECT RAISE(ABORT, 'reject snapshot'); END",
			)
			.run();
		try {
			expect(await (await GET(request())).json()).toMatchObject({
				appsProcessed: 0,
			});
			expect(
				(
					await fixture.database
						.select()
						.from(developerCreditAccounts)
						.where(eq(developerCreditAccounts.id, value.accountId))
				)[0]?.balanceMicroCredits,
			).toBe(10000);
			expect(
				await fixture.database
					.select()
					.from(developerCreditTransactions)
					.where(eq(developerCreditTransactions.accountId, value.accountId)),
			).toHaveLength(0);
		} finally {
			await fixture.binding.prepare("DROP TRIGGER reject_snapshot").run();
		}
	});
});
it.each([
	[1, 3],
	[10, 33],
	[100, 333],
	[1000, 3330],
	[0.5, 1],
])("%s stored minutes produce %s micro-credits", (minutes, expected) => {
	expect(Math.floor((minutes * 333) / 100)).toBe(expected);
});
