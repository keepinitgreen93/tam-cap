"use server";

import { getCurrentUser } from "@cap/database/auth/session";
import { requireOrganizationManager } from "@cap/database/cloudflare/access";
import { db } from "@cap/database/cloudflare/application";
import { atomic } from "@cap/database/cloudflare/atomic";
import { organizationInvites } from "@cap/database/cloudflare/schema";
import type { Organisation } from "@cap/web-domain";
import { and, eq } from "drizzle-orm";
import { revalidatePath } from "next/cache";

export async function removeOrganizationInvite(
	inviteId: string,
	organizationId: Organisation.OrganisationId,
) {
	const user = await getCurrentUser();
	if (!user) throw new Error("Unauthorized");
	const database = db();
	await atomic(database, async (snapshot) => {
		await requireOrganizationManager(snapshot, organizationId, user.id);
		const condition = and(
			eq(organizationInvites.id, inviteId),
			eq(organizationInvites.organizationId, organizationId),
		);
		const [invite] = await snapshot.read((reader) =>
			reader
				.select({ id: organizationInvites.id })
				.from(organizationInvites)
				.where(condition)
				.limit(1),
		);
		if (!invite) throw new Error("Invite not found");
		return {
			statements: [database.delete(organizationInvites).where(condition)],
			result: undefined,
		};
	});
	revalidatePath("/dashboard/settings/organization");
	return { success: true };
}
