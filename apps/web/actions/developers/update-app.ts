"use server";

import { getCurrentUser } from "@cap/database/auth/session";
import { developerApps } from "@cap/database/cloudflare/schema";
import { eq } from "drizzle-orm";
import { revalidatePath } from "next/cache";
import { mutateOwnedDeveloperApp } from "@/lib/developer-persistence";

export async function updateDeveloperApp(data: {
	appId: string;
	name?: string;
	environment?: "development" | "production";
	logoUrl?: string | null;
}) {
	const user = await getCurrentUser();
	if (!user) throw new Error("Unauthorized");

	const updates: Partial<typeof developerApps.$inferInsert> = {};
	if (data.name !== undefined) {
		const trimmed = data.name.trim();
		if (!trimmed) throw new Error("App name cannot be empty");
		if (trimmed.length > 255) throw new Error("App name is too long");
		updates.name = trimmed;
	}
	if (data.environment !== undefined) updates.environment = data.environment;
	if (data.logoUrl !== undefined) updates.logoUrl = data.logoUrl;

	await mutateOwnedDeveloperApp(user.id, data.appId, (database) =>
		Object.keys(updates).length > 0
			? [
					database
						.update(developerApps)
						.set(updates)
						.where(eq(developerApps.id, data.appId)),
				]
			: [],
	);

	revalidatePath("/dashboard/developers");
	return { success: true };
}
