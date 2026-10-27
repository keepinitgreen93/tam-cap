"use server";

import { db } from "@cap/database/legacy";
import { getCurrentUser } from "@cap/database/auth/session";
import { organizations } from "@cap/database/legacy/schema";
import type { Organisation } from "@cap/web-domain";
import { eq } from "drizzle-orm";
import { requireOrganizationSettingsManager } from "./authorization";
import { checkDomainStatus } from "./domain-utils";

export async function checkOrganizationDomain(
	organizationId: Organisation.OrganisationId,
) {
	if (process.env.CAP_RUNTIME === "cloudflare")
		throw new Error(
			"Domain provisioning is managed by this instance's operator",
		);
	const user = await getCurrentUser();

	if (!user || !organizationId) {
		throw new Error("Unauthorized");
	}

	const [organization] = await db()
		.select()
		.from(organizations)
		.where(eq(organizations.id, organizationId));

	if (!organization) throw new Error("Organization not found");

	await requireOrganizationSettingsManager(user.id, organizationId);

	if (!organization.customDomain) {
		throw new Error("No custom domain set");
	}

	try {
		const status = await checkDomainStatus(organization.customDomain);

		if (status.verified && !organization.domainVerified) {
			await db()
				.update(organizations)
				.set({
					domainVerified: new Date(),
				})
				.where(eq(organizations.id, organizationId));
		} else if (!status.verified && organization.domainVerified) {
			await db()
				.update(organizations)
				.set({
					domainVerified: null,
				})
				.where(eq(organizations.id, organizationId));
		}

		return status;
	} catch (error) {
		if (error instanceof Error) {
			throw new Error(error.message);
		}
		throw new Error("Failed to check domain status");
	}
}
