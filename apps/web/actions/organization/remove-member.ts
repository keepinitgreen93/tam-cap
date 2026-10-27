"use server";

import { normalizeEmail } from "@cap/database/auth/identity";
import { getCurrentUser } from "@cap/database/auth/session";
import { db } from "@cap/database/cloudflare/application";
import { type AtomicStatement, atomic } from "@cap/database/cloudflare/atomic";
import { releaseProSeatStatement } from "@cap/database/cloudflare/pro-seat";
import {
	organizationInvites,
	organizationMembers,
	organizations,
	spaceMembers,
	spaces,
	users,
} from "@cap/database/cloudflare/schema";
import type { Organisation } from "@cap/web-domain";
import { and, eq, inArray } from "drizzle-orm";
import { revalidatePath } from "next/cache";
import {
	canRemoveOrganizationMember,
	getEffectiveOrganizationRole,
} from "@/lib/permissions/roles";
import { requireOrganizationSettingsManager } from "./authorization";

export async function removeOrganizationMember(
	memberId: string,
	organizationId: Organisation.OrganisationId,
) {
	const user = await getCurrentUser();
	if (!user) throw new Error("Unauthorized");

	await requireOrganizationSettingsManager(user.id, organizationId);

	const database = db();
	await atomic(database, async (snapshot) => {
		const [organization] = await snapshot.read((reader) =>
			reader
				.select()
				.from(organizations)
				.where(eq(organizations.id, organizationId))
				.limit(1),
		);
		const [actorMember] = await snapshot.read((reader) =>
			reader
				.select()
				.from(organizationMembers)
				.where(
					and(
						eq(organizationMembers.organizationId, organizationId),
						eq(organizationMembers.userId, user.id),
					),
				)
				.limit(1),
		);
		const [member] = await snapshot.read((reader) =>
			reader
				.select({
					id: organizationMembers.id,
					userId: organizationMembers.userId,
					role: organizationMembers.role,
					hasProSeat: organizationMembers.hasProSeat,
					email: users.email,
				})
				.from(organizationMembers)
				.innerJoin(users, eq(organizationMembers.userId, users.id))
				.where(
					and(
						eq(organizationMembers.id, memberId),
						eq(organizationMembers.organizationId, organizationId),
					),
				)
				.limit(1),
		);
		if (!organization || organization.tombstoneAt || !member)
			throw new Error("Member not found");
		const actorRole = getEffectiveOrganizationRole({
			userId: user.id,
			ownerId: organization.ownerId,
			memberRole: actorMember?.role,
		});
		const targetRole = getEffectiveOrganizationRole({
			userId: member.userId,
			ownerId: organization.ownerId,
			memberRole: member.role,
		});
		if (
			!canRemoveOrganizationMember({
				actorRole,
				actorUserId: user.id,
				targetUserId: member.userId,
				ownerId: organization.ownerId,
				targetRole,
			})
		)
			throw new Error("You do not have permission to remove this member");
		const statements: AtomicStatement[] = [
			database
				.delete(organizationMembers)
				.where(
					and(
						eq(organizationMembers.id, memberId),
						eq(organizationMembers.organizationId, organizationId),
					),
				),
		];
		if (member.hasProSeat)
			statements.push(releaseProSeatStatement(database, member.userId));
		const organizationSpaces = database
			.select({ id: spaces.id })
			.from(spaces)
			.where(eq(spaces.organizationId, organizationId));
		statements.push(
			database
				.delete(spaceMembers)
				.where(
					and(
						eq(spaceMembers.userId, member.userId),
						inArray(spaceMembers.spaceId, organizationSpaces),
					),
				),
		);
		statements.push(
			database
				.delete(organizationInvites)
				.where(
					and(
						eq(organizationInvites.organizationId, organizationId),
						eq(organizationInvites.invitedEmail, normalizeEmail(member.email)),
					),
				),
		);
		return { statements, result: undefined };
	});

	revalidatePath("/dashboard/settings/organization");
	revalidatePath("/dashboard");
	return { success: true };
}
