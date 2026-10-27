import type { CloudflareDatabase } from "@cap/database/cloudflare";
import {
	developerApiKeys,
	developerApps,
	developerCreditAccounts,
	developerCreditTransactions,
} from "@cap/database/cloudflare/schema";
import { nanoId } from "@cap/database/helpers";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, expect, it, vi } from "vitest";
import { createTestDatabase } from "../../../../packages/database/cloudflare/test-runtime";
import { createTestOwner } from "../helpers/cloudflare-team";

let database: CloudflareDatabase;
let runtime: Awaited<ReturnType<typeof createTestDatabase>>;
vi.mock("@cap/database/cloudflare/application", () => ({ db: () => database }));
beforeAll(async () => {
	runtime = await createTestDatabase();
	database = runtime.database;
});
afterAll(async () => runtime.dispose());

async function fixture() {
	const user = await createTestOwner(database);
	const appId = nanoId();
	const accountId = nanoId();
	await database.batch([
		database.insert(developerApps).values({
			id: appId,
			ownerId: user.id,
			name: "App",
			environment: "development",
		}),
		database
			.insert(developerCreditAccounts)
			.values({ id: accountId, appId, ownerId: user.id }),
	]);
	return { user, appId, accountId };
}

it("credits concurrent distinct payments without losing a balance update", async () => {
	const { addCreditsToAccount } = await import("@/lib/developer-credits");
	const { accountId } = await fixture();
	const balances = await Promise.all(
		Array.from({ length: 4 }, (_, i) =>
			addCreditsToAccount({
				accountId,
				amountCents: 100,
				referenceId: `payment-${i}`,
				referenceType: "stripe_payment_intent",
			}),
		),
	);
	expect(balances.sort((a, b) => a - b)).toEqual([
		100000, 200000, 300000, 400000,
	]);
	expect(
		(
			await database
				.select()
				.from(developerCreditAccounts)
				.where(eq(developerCreditAccounts.id, accountId))
		)[0]?.balanceMicroCredits,
	).toBe(400000);
});

it("deduplicates concurrent and replayed payment references", async () => {
	const { addCreditsToAccount } = await import("@/lib/developer-credits");
	const { accountId } = await fixture();
	const input = {
		accountId,
		amountCents: 500,
		referenceId: "same-payment",
		referenceType: "stripe_payment_intent" as const,
	};
	expect(
		await Promise.all([addCreditsToAccount(input), addCreditsToAccount(input)]),
	).toEqual([500000, 500000]);
	expect(await addCreditsToAccount(input)).toBe(500000);
	expect(
		await database
			.select()
			.from(developerCreditTransactions)
			.where(eq(developerCreditTransactions.accountId, accountId)),
	).toHaveLength(1);
	await expect(
		addCreditsToAccount({ ...input, amountCents: 100 }),
	).rejects.toThrow("conflicts");
});

it("rolls back the balance if the audit transaction is rejected", async () => {
	const { addCreditsToAccount } = await import("@/lib/developer-credits");
	const { accountId } = await fixture();
	await runtime.binding
		.prepare(
			"CREATE TRIGGER reject_topup BEFORE INSERT ON developer_credit_transactions BEGIN SELECT RAISE(ABORT, 'reject topup'); END",
		)
		.run();
	try {
		await expect(
			addCreditsToAccount({ accountId, amountCents: 100 }),
		).rejects.toThrow();
		expect(
			(
				await database
					.select()
					.from(developerCreditAccounts)
					.where(eq(developerCreditAccounts.id, accountId))
			)[0]?.balanceMicroCredits,
		).toBe(0);
	} finally {
		await runtime.binding.prepare("DROP TRIGGER reject_topup").run();
	}
});

it("rejects non-owners and deleted apps before planning a mutation", async () => {
	const { mutateOwnedDeveloperApp } = await import(
		"@/lib/developer-persistence"
	);
	const { user, appId } = await fixture();
	const stranger = await createTestOwner(database);
	const planner = vi.fn(() => []);
	await expect(
		mutateOwnedDeveloperApp(stranger.id, appId, planner),
	).rejects.toThrow("App not found");
	await database
		.update(developerApps)
		.set({ deletedAt: new Date() })
		.where(eq(developerApps.id, appId));
	await expect(
		mutateOwnedDeveloperApp(user.id, appId, planner),
	).rejects.toThrow("App not found");
	expect(planner).not.toHaveBeenCalled();
});

it("rolls back key revocation when replacement insertion fails", async () => {
	const { mutateOwnedDeveloperApp } = await import(
		"@/lib/developer-persistence"
	);
	const { user, appId } = await fixture();
	const id = nanoId();
	await database.insert(developerApiKeys).values({
		id,
		appId,
		keyType: "secret",
		encryptedKey: "encrypted",
		keyHash: "hash",
		keyPrefix: "csk_x",
	});
	await expect(
		mutateOwnedDeveloperApp(user.id, appId, (db) => [
			db
				.update(developerApiKeys)
				.set({ revokedAt: new Date() })
				.where(eq(developerApiKeys.id, id)),
			db.insert(developerApiKeys).values({
				id,
				appId,
				keyType: "secret",
				encryptedKey: "encrypted",
				keyHash: "duplicate",
				keyPrefix: "csk_y",
			}),
		]),
	).rejects.toThrow();
	expect(
		(
			await database
				.select()
				.from(developerApiKeys)
				.where(eq(developerApiKeys.id, id))
		)[0]?.revokedAt,
	).toBeNull();
});
