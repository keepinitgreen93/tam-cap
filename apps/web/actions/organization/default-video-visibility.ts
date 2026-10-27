"use server";

import { getCurrentUser } from "@cap/database/auth/session";
import { requireOrganizationManager } from "@cap/database/cloudflare/access";
import { db } from "@cap/database/cloudflare/application";
import { atomic } from "@cap/database/cloudflare/atomic";
import { organizations } from "@cap/database/cloudflare/schema";
import { eq } from "drizzle-orm";
import { revalidatePath } from "next/cache";

export async function updateDefaultVideoVisibility(privateByDefault: boolean) {
	const user = await getCurrentUser();
	if (!user?.activeOrganizationId) throw new Error("Unauthorized");

	const organizationId = user.activeOrganizationId;
	const database = db();
	await atomic(database, async (snapshot) => {
		await requireOrganizationManager(snapshot, organizationId, user.id);
		return {
			statements: [
				database
					.update(organizations)
					.set({ defaultVideoVisibility: privateByDefault ? "private" : null })
					.where(eq(organizations.id, organizationId)),
			],
			result: undefined,
		};
	});

	revalidatePath("/dashboard/settings/organization/preferences");
	revalidatePath("/dashboard/caps");
	return { success: true };
}
