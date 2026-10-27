"use server";

import { getCurrentUser } from "@cap/database/auth/session";
import { requireOrganizationManager } from "@cap/database/cloudflare/access";
import { db } from "@cap/database/cloudflare/application";
import { atomic } from "@cap/database/cloudflare/atomic";
import { organizationMembers } from "@cap/database/cloudflare/schema";
import type { Organisation } from "@cap/web-domain";
import { and, eq } from "drizzle-orm";
import { revalidatePath } from "next/cache";
import {
	canChangeOrganizationMemberRole,
	getEffectiveOrganizationRole,
	normalizeAssignableOrganizationRole,
} from "@/lib/permissions/roles";

export async function updateOrganizationMemberRole(
	memberId: string,
	organizationId: Organisation.OrganisationId,
	roleInput: string,
) {
	const user = await getCurrentUser();
	if (!user) throw new Error("Unauthorized");

	const nextRole = normalizeAssignableOrganizationRole(roleInput);
	if (!nextRole) throw new Error("Invalid organization role");

	const database = db();
	await atomic(database, async (snapshot) => {
		const access = await requireOrganizationManager(
			snapshot,
			organizationId,
			user.id,
		);
		const actor = { role: access.role, ownerId: access.organization.ownerId };

		const [member] = await snapshot.read((reader) =>
			reader
				.select({
					id: organizationMembers.id,
					userId: organizationMembers.userId,
					role: organizationMembers.role,
				})
				.from(organizationMembers)
				.where(
					and(
						eq(organizationMembers.id, memberId),
						eq(organizationMembers.organizationId, organizationId),
					),
				)
				.limit(1),
		);

		if (!member) throw new Error("Member not found");

		const targetRole = getEffectiveOrganizationRole({
			userId: member.userId,
			ownerId: actor.ownerId,
			memberRole: member.role,
		});

		if (
			!canChangeOrganizationMemberRole({
				actorRole: actor.role,
				actorUserId: user.id,
				targetUserId: member.userId,
				ownerId: actor.ownerId,
				targetRole,
				nextRole,
			})
		) {
			throw new Error("You do not have permission to update this member role");
		}

		return {
			statements: [
				database
					.update(organizationMembers)
					.set({ role: nextRole })
					.where(eq(organizationMembers.id, memberId)),
			],
			result: undefined,
		};
	});

	revalidatePath("/dashboard/settings/organization");
	revalidatePath("/dashboard");

	return { success: true };
}
