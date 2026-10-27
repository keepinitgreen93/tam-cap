import { db } from "@cap/database/cloudflare/application";
import { atomic } from "@cap/database/cloudflare/atomic";
import { integrationInstallations } from "@cap/database/cloudflare/schema";
import { decrypt, encrypt } from "@cap/database/crypto";
import { nanoId } from "@cap/database/helpers";
import type { Organisation, User } from "@cap/web-domain";
import { and, asc, eq } from "drizzle-orm";

export type IntegrationInstallationSummary = {
	id: string;
	externalId: string;
	displayName: string;
	createdAt: Date;
	updatedAt: Date;
};

export const saveIntegrationInstallation = async ({
	provider,
	externalId,
	displayName,
	organizationId,
	installedByUserId,
	credentials,
	metadata,
}: {
	provider: string;
	externalId: string;
	displayName: string;
	organizationId: Organisation.OrganisationId;
	installedByUserId: User.UserId;
	credentials: Record<string, unknown>;
	metadata: Record<string, unknown>;
}) => {
	const encryptedCredentials = await encrypt(JSON.stringify(credentials));
	const candidateId = nanoId();
	const database = db();
	const now = new Date();
	await atomic(database, async (snapshot) => {
		const [installation] = await snapshot.read((reader) =>
			reader
				.select()
				.from(integrationInstallations)
				.where(
					and(
						eq(integrationInstallations.provider, provider),
						eq(integrationInstallations.externalId, externalId),
					),
				)
				.limit(1),
		);
		if (installation && installation.organizationId !== organizationId)
			throw new Error(
				"Integration is already connected to another organization",
			);
		return {
			statements: [
				installation
					? database
							.update(integrationInstallations)
							.set({
								displayName,
								installedByUserId,
								encryptedCredentials,
								metadata,
								updatedAt: now,
							})
							.where(eq(integrationInstallations.id, installation.id))
					: database.insert(integrationInstallations).values({
							id: candidateId,
							provider,
							externalId,
							displayName,
							organizationId,
							installedByUserId,
							encryptedCredentials,
							metadata,
						}),
			],
			result: undefined,
		};
	});
};
export const listIntegrationInstallations = async ({
	organizationId,
	provider,
}: {
	organizationId: Organisation.OrganisationId;
	provider: string;
}): Promise<IntegrationInstallationSummary[]> =>
	db()
		.select({
			id: integrationInstallations.id,
			externalId: integrationInstallations.externalId,
			displayName: integrationInstallations.displayName,
			createdAt: integrationInstallations.createdAt,
			updatedAt: integrationInstallations.updatedAt,
		})
		.from(integrationInstallations)
		.where(
			and(
				eq(integrationInstallations.organizationId, organizationId),
				eq(integrationInstallations.provider, provider),
			),
		)
		.orderBy(asc(integrationInstallations.displayName));

export const getIntegrationCredentials = async ({
	provider,
	externalId,
}: {
	provider: string;
	externalId: string;
}): Promise<unknown | null> => {
	const [installation] = await db()
		.select({
			encryptedCredentials: integrationInstallations.encryptedCredentials,
		})
		.from(integrationInstallations)
		.where(
			and(
				eq(integrationInstallations.provider, provider),
				eq(integrationInstallations.externalId, externalId),
			),
		)
		.limit(1);
	if (!installation) return null;
	return JSON.parse(
		await decrypt(installation.encryptedCredentials),
	) as unknown;
};

export const deleteIntegrationInstallation = async ({
	provider,
	organizationId,
	installationId,
}: {
	provider: string;
	organizationId: Organisation.OrganisationId;
	installationId: string;
}) => {
	await db()
		.delete(integrationInstallations)
		.where(
			and(
				eq(integrationInstallations.provider, provider),
				eq(integrationInstallations.id, installationId),
				eq(integrationInstallations.organizationId, organizationId),
			),
		);
};

export const deleteIntegrationInstallationByExternalId = async ({
	provider,
	externalId,
}: {
	provider: string;
	externalId: string;
}) => {
	await db()
		.delete(integrationInstallations)
		.where(
			and(
				eq(integrationInstallations.provider, provider),
				eq(integrationInstallations.externalId, externalId),
			),
		);
};
