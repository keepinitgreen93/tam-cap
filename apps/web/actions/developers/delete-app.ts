"use server";

import { getCurrentUser } from "@cap/database/auth/session";
import {
	developerApiKeys,
	developerApps,
} from "@cap/database/cloudflare/schema";
import { and, eq, isNull } from "drizzle-orm";
import { revalidatePath } from "next/cache";
import { mutateOwnedDeveloperApp } from "@/lib/developer-persistence";

export async function deleteDeveloperApp(appId: string) {
	const user = await getCurrentUser();
	if (!user) throw new Error("Unauthorized");

	const now = new Date();
	await mutateOwnedDeveloperApp(user.id, appId, (database) => [
		database
			.update(developerApiKeys)
			.set({ revokedAt: now })
			.where(
				and(
					eq(developerApiKeys.appId, appId),
					isNull(developerApiKeys.revokedAt),
				),
			),

		database
			.update(developerApps)
			.set({ deletedAt: now })
			.where(eq(developerApps.id, appId)),
	]);

	revalidatePath("/dashboard/developers");
	return { success: true };
}
