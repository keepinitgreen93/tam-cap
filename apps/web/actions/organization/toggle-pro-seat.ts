"use server";

import { getCurrentUser } from "@cap/database/auth/session";
import { requireOrganizationManager } from "@cap/database/cloudflare/access";
import { db } from "@cap/database/cloudflare/application";
import { atomic } from "@cap/database/cloudflare/atomic";
import { releaseProSeatStatement } from "@cap/database/cloudflare/pro-seat";
import { organizationMembers } from "@cap/database/cloudflare/schema";
import type { Organisation } from "@cap/web-domain";
import { and, eq } from "drizzle-orm";
import { revalidatePath } from "next/cache";

export async function toggleProSeat(
	memberId: string,
	organizationId: Organisation.OrganisationId,
	enable: boolean,
) {
	const user = await getCurrentUser();
	if (!user) throw new Error("Unauthorized");
	const database = db();
	await atomic(database, async (snapshot) => {
		const { organization } = await requireOrganizationManager(
			snapshot,
			organizationId,
			user.id,
		);
		const [member] = await snapshot.read((reader) =>
			reader
				.select()
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
		if (member.userId === organization.ownerId)
			throw new Error("Cannot toggle Pro seat for the organization owner");
		return {
			statements: [
				database
					.update(organizationMembers)
					.set({ hasProSeat: enable })
					.where(eq(organizationMembers.id, memberId)),
				...(!enable ? [releaseProSeatStatement(database, member.userId)] : []),
			],
			result: undefined,
		};
	});
	revalidatePath("/dashboard/settings/organization");
	return { success: true };
}
