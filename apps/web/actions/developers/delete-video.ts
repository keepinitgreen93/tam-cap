"use server";

import { getCurrentUser } from "@cap/database/auth/session";
import { developerVideos } from "@cap/database/cloudflare/schema";
import { and, eq } from "drizzle-orm";
import { revalidatePath } from "next/cache";
import { mutateOwnedDeveloperApp } from "@/lib/developer-persistence";

export async function deleteDeveloperVideo(appId: string, videoId: string) {
	const user = await getCurrentUser();
	if (!user) throw new Error("Unauthorized");

	const now = new Date();
	await mutateOwnedDeveloperApp(user.id, appId, (database) => [
		database
			.update(developerVideos)
			.set({ deletedAt: now })
			.where(
				and(eq(developerVideos.id, videoId), eq(developerVideos.appId, appId)),
			),
	]);

	revalidatePath("/dashboard/developers");
	return { success: true };
}
