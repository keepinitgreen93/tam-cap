"use server";

import { getCurrentUser } from "@cap/database/auth/session";
import { db } from "@cap/database/cloudflare/application";
import { notifications } from "@cap/database/cloudflare/schema";
import { and, eq } from "drizzle-orm";
import { revalidatePath } from "next/cache";

export const markAsRead = async (notificationId?: string) => {
	const currentUser = await getCurrentUser();
	if (!currentUser) {
		throw new Error("User not found");
	}

	try {
		const now = new Date();
		await db()
			.update(notifications)
			.set({ readAt: now })
			.where(
				and(
					eq(notifications.recipientId, currentUser.id),
					notificationId
						? eq(notifications.id, notificationId)
						: eq(notifications.orgId, currentUser.activeOrganizationId),
				),
			);
	} catch (error) {
		console.log(error);
		throw new Error("Error marking notification(s) as read");
	}

	revalidatePath("/dashboard");
};
