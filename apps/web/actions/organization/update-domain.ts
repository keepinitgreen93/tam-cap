"use server";

import { db } from "@cap/database/legacy";
import { getCurrentUser } from "@cap/database/auth/session";
import { organizations } from "@cap/database/legacy/schema";
import { userIsPro } from "@cap/utils";
import type { Organisation } from "@cap/web-domain";
import { eq } from "drizzle-orm";
import { revalidatePath } from "next/cache";
import { requireOrganizationSettingsManager } from "./authorization";
import { addDomain, checkDomainStatus } from "./domain-utils";

export async function updateDomain(
	domain: string,
	organizationId: Organisation.OrganisationId,
) {
	if (process.env.CAP_RUNTIME === "cloudflare")
		throw new Error(
			"Domain provisioning is managed by this instance's operator",
		);
	const user = await getCurrentUser();

	if (!user) {
		throw new Error("Unauthorized");
	}

	if (!userIsPro(user)) {
		throw new Error("User is not subscribed");
	}

	const normalizedDomain = domain.trim().toLowerCase();

	const [organization] = await db()
		.select()
		.from(organizations)
		.where(eq(organizations.id, organizationId));

	if (!organization) throw new Error("Organization not found");

	await requireOrganizationSettingsManager(user.id, organizationId);

	// Check if domain is already being used by another organization
	const existingDomain = await db()
		.select()
		.from(organizations)
		.where(eq(organizations.customDomain, normalizedDomain))
		.limit(1);

	if (existingDomain.length > 0 && existingDomain[0]?.id !== organizationId) {
		throw new Error("This domain is already being used.");
	}

	try {
		const addDomainResponse = await addDomain(normalizedDomain);

		if (addDomainResponse.error) {
			throw new Error(addDomainResponse.error.message);
		}

		await db()
			.update(organizations)
			.set({
				customDomain: normalizedDomain,
				domainVerified: null,
			})
			.where(eq(organizations.id, organizationId));

		const status = await checkDomainStatus(normalizedDomain);

		if (status.verified) {
			await db()
				.update(organizations)
				.set({
					domainVerified: new Date(),
				})
				.where(eq(organizations.id, organizationId));
		}

		revalidatePath("/dashboard/settings/organization");

		return status;
	} catch (error) {
		if (error instanceof Error) {
			throw new Error(error.message);
		}
	}
}
