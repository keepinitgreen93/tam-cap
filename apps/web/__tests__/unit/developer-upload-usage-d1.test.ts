import {
	developerApps,
	developerCreditAccounts,
	developerCreditTransactions,
	developerVideos,
} from "@cap/database/cloudflare/schema";
import { nanoId } from "@cap/database/helpers";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, expect, it } from "vitest";
import {
	finishDeveloperUpload,
	reserveDeveloperUpload,
} from "@/lib/developer-usage";
import { createTestDatabase } from "../../../../packages/database/cloudflare/test-runtime";
import { createTestOwner } from "../helpers/cloudflare-team";

let fixture: Awaited<ReturnType<typeof createTestDatabase>>;
beforeAll(async () => {
	fixture = await createTestDatabase();
});
afterAll(async () => fixture.dispose());
async function input(balance = 10000) {
	const owner = await createTestOwner(fixture.database);
	const appId = nanoId();
	const accountId = nanoId();
	const videoId = nanoId();
	await fixture.database.batch([
		fixture.database
			.insert(developerApps)
			.values({
				id: appId,
				ownerId: owner.id,
				name: "SDK",
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
		fixture.database.insert(developerVideos).values({ id: videoId, appId }),
	]);
	return {
		appId,
		accountId,
		videoId,
		uploadId: "upload-one",
		amount: 5000,
		durationSeconds: 60,
		totalBytes: 10000,
	};
}
it("reserves one debit across concurrent multipart completion retries", async () => {
	const value = await input();
	expect(
		await Promise.all([
			reserveDeveloperUpload(fixture.database, value),
			reserveDeveloperUpload(fixture.database, value),
		]),
	).toEqual(["reserved", "reserved"]);
	expect(
		(
			await fixture.database
				.select()
				.from(developerCreditAccounts)
				.where(eq(developerCreditAccounts.id, value.accountId))
		)[0]?.balanceMicroCredits,
	).toBe(5000);
	expect(
		await fixture.database
			.select()
			.from(developerCreditTransactions)
			.where(eq(developerCreditTransactions.accountId, value.accountId)),
	).toHaveLength(1);
	await finishDeveloperUpload(fixture.database, {
		...value,
		duration: 60,
		width: 1280,
		height: 720,
		fps: 30,
	});
	expect(await reserveDeveloperUpload(fixture.database, value)).toBe(
		"complete",
	);
	expect(
		await reserveDeveloperUpload(fixture.database, {
			...value,
			uploadId: "other-upload",
		}),
	).toBe("conflict");
});
it("does not debit insufficient credit or another application's video", async () => {
	const value = await input(1);
	expect(await reserveDeveloperUpload(fixture.database, value)).toBe(
		"insufficient",
	);
	const other = await input();
	expect(
		await reserveDeveloperUpload(fixture.database, {
			...other,
			videoId: value.videoId,
		}),
	).toBe("missing");
	expect(
		await fixture.database
			.select()
			.from(developerCreditTransactions)
			.where(eq(developerCreditTransactions.accountId, other.accountId)),
	).toHaveLength(0);
});
it("records self-hosted SDK usage without requiring prepaid balance", async () => {
	const value = await input(0);
	expect(
		await reserveDeveloperUpload(fixture.database, { ...value, amount: 0 }),
	).toBe("reserved");
	await finishDeveloperUpload(fixture.database, { ...value, duration: 60 });
	expect(
		(
			await fixture.database
				.select()
				.from(developerVideos)
				.where(eq(developerVideos.id, value.videoId))
		)[0]?.duration,
	).toBe(60);
});
it("rolls back video publication if its completion receipt fails", async () => {
	const value = await input();
	await reserveDeveloperUpload(fixture.database, value);
	await fixture.binding
		.prepare(
			"CREATE TRIGGER reject_sdk_completion BEFORE UPDATE ON developer_credit_transactions BEGIN SELECT RAISE(ABORT, 'reject receipt'); END",
		)
		.run();
	try {
		await expect(
			finishDeveloperUpload(fixture.database, { ...value, duration: 60 }),
		).rejects.toThrow();
		expect(
			(
				await fixture.database
					.select()
					.from(developerVideos)
					.where(eq(developerVideos.id, value.videoId))
			)[0]?.duration,
		).toBeNull();
	} finally {
		await fixture.binding.prepare("DROP TRIGGER reject_sdk_completion").run();
	}
});
