import type { CloudflareDatabase } from "@cap/database/cloudflare";
import { organizationMembers, users } from "@cap/database/cloudflare/schema";
import {
	createCloudflareUser,
	provisionCloudflareInvitee,
} from "@cap/database/cloudflare/team";
import { nanoId } from "@cap/database/helpers";
import { eq } from "drizzle-orm";

export async function createTestOwner(database: CloudflareDatabase) {
	const email = `${nanoId()}@example.com`;
	return createCloudflareUser(
		database,
		{ email, emailVerified: new Date() },
		{ ownerEmail: email, inviteOnly: true },
	);
}

export async function addTestSeat(
	database: CloudflareDatabase,
	user: typeof users.$inferSelect,
	subscription: string | null,
) {
	const owner = await createTestOwner(database);
	await database
		.update(users)
		.set({ stripeSubscriptionId: subscription })
		.where(eq(users.id, owner.id));
	const invite = await provisionCloudflareInvitee(database, {
		organizationId: owner.activeOrganizationId,
		invitedByUserId: owner.id,
		email: user.email,
		role: "member",
	});
	await database
		.update(organizationMembers)
		.set({ hasProSeat: true })
		.where(eq(organizationMembers.id, invite.memberId));
	if (!invite.inviteId) throw new Error("Test invitation was not created");
	return { owner, invite: { ...invite, inviteId: invite.inviteId } };
}

export async function createTestTeam(database: CloudflareDatabase) {
	const user = await createTestOwner(database);
	const seat = await addTestSeat(database, user, "sub_original");
	await database
		.update(users)
		.set({ thirdPartyStripeSubscriptionId: "sub_original" })
		.where(eq(users.id, user.id));
	return { ...seat, user };
}
