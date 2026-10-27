"use server";

import { getCurrentUser } from "@cap/database/auth/session";
import { db } from "@cap/database/cloudflare/application";
import { users } from "@cap/database/cloudflare/schema";
import { eq, sql } from "drizzle-orm";
import { revalidatePath } from "next/cache";

export const updatePreferences = async ({
	notifications,
}: {
	notifications: {
		pauseComments: boolean;
		pauseReplies: boolean;
		pauseViews: boolean;
		pauseReactions: boolean;
		pauseAnonViews?: boolean;
	};
}) => {
	const currentUser = await getCurrentUser();
	if (!currentUser) {
		throw new Error("User not found");
	}

	try {
		await db()
			.update(users)
			.set({
				preferences: sql`json_set(coalesce(${users.preferences}, '{}'), '$.notifications', json(${JSON.stringify(notifications)}))`,
			})
			.where(eq(users.id, currentUser.id));
		revalidatePath("/dashboard");
	} catch (error) {
		console.log(error);
		throw new Error("Error updating preferences");
	}
};
