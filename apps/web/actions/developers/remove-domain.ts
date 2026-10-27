"use server";

import { getCurrentUser } from "@cap/database/auth/session";
import { developerAppDomains } from "@cap/database/cloudflare/schema";
import { and, eq } from "drizzle-orm";
import { revalidatePath } from "next/cache";
import { mutateOwnedDeveloperApp } from "@/lib/developer-persistence";

export async function removeDeveloperDomain(appId: string, domainId: string) {
	const user = await getCurrentUser();
	if (!user) throw new Error("Unauthorized");

	await mutateOwnedDeveloperApp(user.id, appId, (database) => [
		database
			.delete(developerAppDomains)
			.where(
				and(
					eq(developerAppDomains.id, domainId),
					eq(developerAppDomains.appId, appId),
				),
			),
	]);

	revalidatePath("/dashboard/developers");
	return { success: true };
}
