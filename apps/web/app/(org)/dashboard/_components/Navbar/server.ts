"use server";

import { getCurrentUser } from "@cap/database/auth/session";
import { requireOrganizationMember } from "@cap/database/cloudflare/access";
import { db } from "@cap/database/cloudflare/application";
import { atomic } from "@cap/database/cloudflare/atomic";
import { users } from "@cap/database/cloudflare/schema";
import type { Organisation } from "@cap/web-domain";
import { eq } from "drizzle-orm";
import { revalidatePath } from "next/cache";
import { createSpace as createSpaceAction } from "@/actions/organization/create-space";
import { updateSpace as updateSpaceAction } from "@/actions/organization/update-space";

export async function updateActiveOrganization(
	organizationId: Organisation.OrganisationId,
) {
	const user = await getCurrentUser();
	if (!user) throw new Error("Unauthorized");

	const database = db();
	await atomic(database, async (snapshot) => {
		await requireOrganizationMember(snapshot, organizationId, user.id);
		return {
			statements: [
				database
					.update(users)
					.set({ activeOrganizationId: organizationId })
					.where(eq(users.id, user.id)),
			],
			result: undefined,
		};
	});

	revalidatePath("/dashboard");
}

export async function createSpace(formData: FormData) {
	try {
		const result = await createSpaceAction(formData);

		if (!result.success) {
			throw new Error(result.error || "Failed to create space");
		}

		return result;
	} catch (error) {
		console.error("Error creating space:", error);
		throw error;
	}
}

export async function updateSpace(formData: FormData) {
	try {
		const result = await updateSpaceAction(formData);
		if (!result.success) {
			throw new Error(result.error || "Failed to update space");
		}
		return result;
	} catch (error) {
		console.error("Error updating space:", error);
		throw error;
	}
}
