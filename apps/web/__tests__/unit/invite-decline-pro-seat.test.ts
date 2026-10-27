import { users } from "@cap/database/cloudflare/schema";
import { resolveCloudflareInvite } from "@cap/database/cloudflare/team";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createTestDatabase } from "../../../../packages/database/cloudflare/test-runtime.ts";
import { addTestSeat, createTestTeam } from "../helpers/cloudflare-team";

let fixture: Awaited<ReturnType<typeof createTestDatabase>>;
const sponsor = async (userId: typeof users.$inferSelect.id) => {
	const [user] = await fixture.database
		.select()
		.from(users)
		.where(eq(users.id, userId));
	return user?.thirdPartyStripeSubscriptionId;
};
const decline = (userId: typeof users.$inferSelect.id, inviteId: string) =>
	resolveCloudflareInvite(fixture.database, {
		userId,
		inviteId,
		accept: false,
	});

describe("D1 invitation decline sponsorship", () => {
	beforeAll(async () => {
		fixture = await createTestDatabase();
	});
	afterAll(async () => fixture?.dispose());
	it("clears the subscription pointer when the last sponsored seat is removed", async () => {
		const { user, invite } = await createTestTeam(fixture.database);
		await decline(user.id, invite.inviteId);
		expect(await sponsor(user.id)).toBeNull();
	});
	it("preserves the pointer when a manager-sponsored seat remains", async () => {
		const { user, invite } = await createTestTeam(fixture.database);
		await addTestSeat(fixture.database, user, null);
		await decline(user.id, invite.inviteId);
		expect(await sponsor(user.id)).toBe("sub_original");
	});
	it("prefers a remaining owner-paid seat over a manager-sponsored seat", async () => {
		const { user, invite } = await createTestTeam(fixture.database);
		await addTestSeat(fixture.database, user, null);
		await addTestSeat(fixture.database, user, "sub_remaining");
		await decline(user.id, invite.inviteId);
		expect(await sponsor(user.id)).toBe("sub_remaining");
	});
	it("concurrent declines in different organizations cannot leave stale sponsorship", async () => {
		const { user, invite } = await createTestTeam(fixture.database);
		const second = await addTestSeat(fixture.database, user, "sub_second");
		await Promise.all([
			decline(user.id, invite.inviteId),
			decline(user.id, second.invite.inviteId),
		]);
		expect(await sponsor(user.id)).toBeNull();
	});
});
