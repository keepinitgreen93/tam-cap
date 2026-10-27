"use server";

import { getCurrentUser } from "@cap/database/auth/session";
import { requireOrganizationManager } from "@cap/database/cloudflare/access";
import { db } from "@cap/database/cloudflare/application";
import { atomic } from "@cap/database/cloudflare/atomic";
import { organizations } from "@cap/database/cloudflare/schema";
import type { Organisation } from "@cap/web-domain";
import { eq } from "drizzle-orm";
import { revalidatePath } from "next/cache";

export async function updateOrganizationDetails({
	organizationName,
	allowedEmailDomain,
	organizationId,
}: {
	organizationName?: string | null;
	allowedEmailDomain?: string | null;
	organizationId: Organisation.OrganisationId;
}) {
	const user = await getCurrentUser();

	if (!user) {
		throw new Error("Unauthorized");
	}

	const database = db();
	await atomic(database, async (snapshot) => {
		await requireOrganizationManager(snapshot, organizationId, user.id);
		const updates = {
			...(organizationName ? { name: organizationName } : {}),
			...(allowedEmailDomain || allowedEmailDomain === ""
				? { allowedEmailDomain }
				: {}),
		};
		return {
			statements: Object.keys(updates).length
				? [
						database
							.update(organizations)
							.set(updates)
							.where(eq(organizations.id, organizationId)),
					]
				: [],
			result: undefined,
		};
	});

	revalidatePath("/dashboard/settings/organization");

	return { success: true };
}
