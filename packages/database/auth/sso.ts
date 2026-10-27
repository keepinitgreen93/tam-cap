import { domainToASCII } from "node:url";
import { serverEnv } from "@cap/env";
import { hasSsoAccess } from "@cap/utils";
import { Organisation, User } from "@cap/web-domain";
import { WorkOS } from "@workos-inc/node";
import { and, eq, gt, isNull, or } from "drizzle-orm";
import { db } from "../cloudflare/application.ts";
import { type AtomicStatement, atomic } from "../cloudflare/atomic.ts";
import { loopsSyncStatements } from "../cloudflare/loops.ts";
import {
	accounts,
	organizationInvites,
	organizationMembers,
	organizationSso,
	organizations,
	users,
} from "../cloudflare/schema.ts";
import { nanoId } from "../helpers.ts";
import { normalizeEmail } from "./identity.ts";
import type { SsoLoginIntent } from "./sso-state.ts";

export type ValidatedSsoIdentity = {
	organizationId: Organisation.OrganisationId;
	workosOrganizationId: string;
	connectionId: string;
	profileId: string;
	email: string;
};

export type SsoAuthContext = {
	intent: SsoLoginIntent | null;
	actorId: string | null;
};

export function getWorkOS() {
	if (process.env.CAP_RUNTIME === "cloudflare")
		throw new Error("SAML SSO is unavailable on this instance.");
	const { WORKOS_API_KEY, WORKOS_CLIENT_ID } = serverEnv();
	if (!WORKOS_API_KEY || !WORKOS_CLIENT_ID) {
		throw new Error("SAML SSO is not configured. Please contact Cap support.");
	}
	return new WorkOS(WORKOS_API_KEY, {
		clientId: WORKOS_CLIENT_ID,
		timeout: 15_000,
	});
}

export function normalizeSsoDomain(value: string) {
	const input = value.trim().toLowerCase();
	if (!input || input.length > 253 || /[\s/@:#?\\]/.test(input)) return null;
	const domain = domainToASCII(input);
	if (
		!domain ||
		!domain.includes(".") ||
		domain
			.split(".")
			.some((label) => !/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(label))
	) {
		return null;
	}
	return domain;
}

export function getSsoEmailDomain(email: string) {
	const parts = email.trim().split("@");
	if (parts.length !== 2 || !parts[0] || /\s/.test(parts[0])) return null;
	return normalizeSsoDomain(parts[1] ?? "");
}

export async function getRegisteredSsoOrganization(
	organizationId: Organisation.OrganisationId,
) {
	const [record] = await db()
		.select({ organization: organizations, billing: organizationSso })
		.from(organizations)
		.innerJoin(
			organizationSso,
			eq(organizationSso.organizationId, organizations.id),
		)
		.where(
			and(
				eq(organizations.id, organizationId),
				isNull(organizations.tombstoneAt),
			),
		)
		.limit(1);
	if (!record || !hasSsoAccess(record.billing)) {
		throw new Error("SAML SSO is not available for this organization.");
	}
	return record.organization;
}

export async function validateSsoSignIn(
	profile: unknown,
	providerAccountId: string,
	context: SsoAuthContext | undefined,
): Promise<ValidatedSsoIdentity> {
	const intent = context?.intent;
	if (!intent || intent.actorId !== context?.actorId) {
		throw new Error("Your SSO sign-in expired. Please start again.");
	}
	if (!profile || typeof profile !== "object")
		throw new Error("Invalid SSO profile.");
	const raw = profile as Record<string, unknown>;
	if (
		typeof raw.id !== "string" ||
		raw.id !== providerAccountId ||
		raw.organization_id !== intent.workosOrganizationId ||
		raw.connection_id !== intent.connectionId ||
		typeof raw.email !== "string"
	) {
		throw new Error("The SSO identity does not match this organization.");
	}
	const email = normalizeEmail(raw.email);
	const domain = getSsoEmailDomain(email);
	if (!domain || email.length > 255)
		throw new Error("Invalid SSO email address.");
	const organizationId = Organisation.OrganisationId.make(
		intent.organizationId,
	);
	const organization = await getRegisteredSsoOrganization(organizationId);
	if (organization.workosOrganizationId !== intent.workosOrganizationId) {
		throw new Error("The SSO organization is no longer connected.");
	}
	const workos = getWorkOS();
	const [workosOrganization, connection] = await Promise.all([
		workos.organizations.getOrganization(intent.workosOrganizationId),
		workos.sso.getConnection(intent.connectionId),
	]);
	if (
		workosOrganization.id !== intent.workosOrganizationId ||
		connection.organizationId !== workosOrganization.id ||
		connection.id !== intent.connectionId ||
		connection.state !== "active" ||
		!workosOrganization.domains.some(
			(entry) =>
				entry.state === "verified" &&
				normalizeSsoDomain(entry.domain) === domain,
		)
	) {
		throw new Error("Your work email is not verified for this SSO connection.");
	}
	const linkedUsers = await db()
		.selectDistinct({ id: users.id, email: users.email })
		.from(accounts)
		.innerJoin(users, eq(accounts.userId, users.id))
		.where(
			and(
				eq(accounts.provider, "workos"),
				eq(accounts.providerAccountId, raw.id),
			),
		)
		.limit(2);
	if (
		linkedUsers.some(
			(user) =>
				normalizeEmail(user.email) !== email ||
				(linkedUsers[0] && user.id !== linkedUsers[0].id),
		)
	) {
		throw new Error(
			"This SSO identity is already linked to a different account.",
		);
	}
	if (context.actorId) {
		const [actor] = await db()
			.select({ id: users.id, email: users.email })
			.from(users)
			.where(eq(users.id, User.UserId.make(context.actorId)))
			.limit(1);
		if (
			!actor ||
			normalizeEmail(actor.email) !== email ||
			linkedUsers.some((user) => user.id !== actor.id)
		) {
			throw new Error(
				"Sign out of your current account before using this SSO identity.",
			);
		}
	}
	return {
		organizationId,
		workosOrganizationId: workosOrganization.id,
		connectionId: connection.id,
		profileId: raw.id,
		email,
	};
}

export async function provisionSsoMembership(
	userId: User.UserId,
	identity: ValidatedSsoIdentity,
) {
	const database = db();
	const memberId = nanoId();
	const now = new Date();
	await atomic(database, async (snapshot) => {
		const [organization] = await snapshot.read((reader) =>
			reader
				.select()
				.from(organizations)
				.where(eq(organizations.id, identity.organizationId)),
		);
		const [billing] = await snapshot.read((reader) =>
			reader
				.select()
				.from(organizationSso)
				.where(eq(organizationSso.organizationId, identity.organizationId)),
		);
		const [user] = await snapshot.read((reader) =>
			reader.select().from(users).where(eq(users.id, userId)),
		);
		if (
			!organization ||
			organization.tombstoneAt ||
			organization.workosOrganizationId !== identity.workosOrganizationId ||
			!hasSsoAccess(billing) ||
			!user ||
			normalizeEmail(user.email) !== normalizeEmail(identity.email)
		)
			throw new Error(
				"The SSO organization or account is no longer available.",
			);
		const linkedAccounts = await snapshot.read((reader) =>
			reader
				.selectDistinct({ userId: accounts.userId })
				.from(accounts)
				.where(
					and(
						eq(accounts.provider, "workos"),
						eq(accounts.providerAccountId, identity.profileId),
					),
				)
				.limit(2),
		);
		if (linkedAccounts.length !== 1 || linkedAccounts[0]?.userId !== userId)
			throw new Error("The SSO account is not linked to this user.");
		const [member] = await snapshot.read((reader) =>
			reader
				.select({ id: organizationMembers.id })
				.from(organizationMembers)
				.where(
					and(
						eq(organizationMembers.userId, userId),
						eq(organizationMembers.organizationId, identity.organizationId),
					),
				)
				.limit(1),
		);
		const statements: AtomicStatement[] = [];
		if (!member && organization.ownerId !== userId) {
			const [invite] = await snapshot.read((reader) =>
				reader
					.select({ id: organizationInvites.id })
					.from(organizationInvites)
					.where(
						and(
							eq(organizationInvites.organizationId, identity.organizationId),
							eq(
								organizationInvites.invitedEmail,
								normalizeEmail(identity.email),
							),
							eq(organizationInvites.status, "pending"),
							or(
								isNull(organizationInvites.expiresAt),
								gt(organizationInvites.expiresAt, now),
							),
						),
					)
					.limit(1),
			);
			if (!invite)
				throw new Error(
					"An organization invitation is required before joining through SSO.",
				);
		}
		if (!member)
			statements.push(
				database.insert(organizationMembers).values({
					id: memberId,
					userId,
					organizationId: identity.organizationId,
					role: organization.ownerId === userId ? "owner" : "member",
					hasProSeat: false,
				}),
			);
		statements.push(
			database
				.update(organizationInvites)
				.set({ status: "accepted" })
				.where(
					and(
						eq(organizationInvites.organizationId, identity.organizationId),
						eq(
							organizationInvites.invitedEmail,
							normalizeEmail(identity.email),
						),
						eq(organizationInvites.status, "pending"),
					),
				),
			database
				.update(users)
				.set({
					activeOrganizationId: identity.organizationId,
					marketingOrigin: "teammate",
					defaultOrgId: user.defaultOrgId || identity.organizationId,
					emailVerified: user.emailVerified ?? now,
					onboarding_completed_at: user.onboarding_completed_at ?? now,
					onboardingSteps: {
						...user.onboardingSteps,
						welcome: true,
						organizationSetup: true,
						customDomain: true,
						inviteTeam: true,
						download: true,
					},
				})
				.where(eq(users.id, userId)),
			...loopsSyncStatements(
				database,
				userId,
				!member || !user.onboarding_completed_at,
			),
		);
		return { statements, result: undefined };
	});
}
