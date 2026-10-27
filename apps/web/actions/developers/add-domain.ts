"use server";

import { getCurrentUser } from "@cap/database/auth/session";
import { developerAppDomains } from "@cap/database/cloudflare/schema";
import { nanoId } from "@cap/database/helpers";
import { revalidatePath } from "next/cache";
import { mutateOwnedDeveloperApp } from "@/lib/developer-persistence";

export async function addDeveloperDomain(appId: string, domain: string) {
	const user = await getCurrentUser();
	if (!user) throw new Error("Unauthorized");

	const trimmed = domain.trim().toLowerCase();
	if (!trimmed) throw new Error("Domain is required");

	const urlPattern = /^https?:\/\/[a-z0-9.-]+(:[0-9]+)?$/;
	if (!urlPattern.test(trimmed)) {
		throw new Error("Domain must be a valid origin (e.g. https://myapp.com)");
	}

	const domainId = nanoId();
	await mutateOwnedDeveloperApp(user.id, appId, (database) => [
		database.insert(developerAppDomains).values({
			id: domainId,
			appId,
			domain: trimmed,
		}),
	]);

	revalidatePath("/dashboard/developers");
	return { success: true };
}
