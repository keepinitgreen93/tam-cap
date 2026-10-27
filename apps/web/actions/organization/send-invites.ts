"use server";

import { normalizeEmail } from "@cap/database/auth/identity";
import { getCurrentUser } from "@cap/database/auth/session";
import { db } from "@cap/database/cloudflare/application";
import { type AtomicStatement, atomic } from "@cap/database/cloudflare/atomic";
import {
	organizationInvites,
	organizationMembers,
	organizations,
	users,
} from "@cap/database/cloudflare/schema";
import { sendEmail } from "@cap/database/emails/config";
import { OrganizationInvite } from "@cap/database/emails/organization-invite";
import { nanoId } from "@cap/database/helpers";
import { serverEnv } from "@cap/env";
import type { Organisation } from "@cap/web-domain";
import { and, eq, inArray } from "drizzle-orm";
import { revalidatePath } from "next/cache";
import { provisionOrganizationInvitee } from "@/lib/organization-provisioning";
import {
	type AssignableOrganizationRole,
	normalizeAssignableOrganizationRole,
} from "@/lib/permissions/roles";
import { requireOrganizationSettingsManager } from "./authorization";

type OrganizationInviteInput = {
	email: string;
	role?: string | null;
};

export async function sendOrganizationInvites(
	inviteInputs: string[] | OrganizationInviteInput[],
	organizationId: Organisation.OrganisationId,
	roleInput = "member",
	options: { sendEmailNotifications?: boolean } = {},
) {
	const user = await getCurrentUser();

	if (!user) {
		throw new Error("Unauthorized");
	}

	const role = normalizeAssignableOrganizationRole(roleInput);
	if (!role) {
		throw new Error("Invalid organization role");
	}

	const [organization] = await db()
		.select()
		.from(organizations)
		.where(eq(organizations.id, organizationId));

	if (!organization) {
		throw new Error("Organization not found");
	}

	await requireOrganizationSettingsManager(user.id, organizationId);

	const MAX_INVITES = 50;
	if (inviteInputs.length > MAX_INVITES) {
		throw new Error(`Cannot send more than ${MAX_INVITES} invites at once`);
	}

	const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
	const inviteMap = new Map<string, AssignableOrganizationRole>();

	for (const inviteInput of inviteInputs) {
		const email =
			typeof inviteInput === "string" ? inviteInput : inviteInput.email;
		let normalizedEmail: string;
		try {
			normalizedEmail = normalizeEmail(email);
		} catch {
			continue;
		}
		if (!emailRegex.test(normalizedEmail)) continue;

		const inviteRole =
			typeof inviteInput === "string" || !inviteInput.role
				? role
				: normalizeAssignableOrganizationRole(inviteInput.role);

		if (!inviteRole) {
			throw new Error("Invalid organization role");
		}

		inviteMap.set(normalizedEmail, inviteRole);
	}

	const validInvites = Array.from(inviteMap, ([email, inviteRole]) => ({
		email,
		role: inviteRole,
	}));
	const validEmails = validInvites.map((invite) => invite.email);

	if (validEmails.length === 0) {
		return {
			success: true,
			failedEmails: [] as string[],
			skippedEmails: [] as string[],
		};
	}

	if (options.sendEmailNotifications === false) {
		const provisionResults = await Promise.allSettled(
			validInvites.map((invite) =>
				provisionOrganizationInvitee({
					organizationId,
					email: invite.email,
					invitedByUserId: user.id,
					role: invite.role,
				}),
			),
		);
		const failedEmails = validInvites
			.filter((_, index) => provisionResults[index]?.status === "rejected")
			.map((invite) => invite.email);

		revalidatePath("/dashboard/settings/organization");

		return { success: true, failedEmails, skippedEmails: [] as string[] };
	}

	const proposed = validInvites.map((invite) => ({ ...invite, id: nanoId() }));
	const database = db();
	const inviteRecords = await atomic(database, async (snapshot) => {
		const [currentOrganization] = await snapshot.read((reader) =>
			reader
				.select()
				.from(organizations)
				.where(eq(organizations.id, organizationId))
				.limit(1),
		);
		const [actor] = await snapshot.read((reader) =>
			reader
				.select()
				.from(organizationMembers)
				.where(
					and(
						eq(organizationMembers.organizationId, organizationId),
						eq(organizationMembers.userId, user.id),
					),
				)
				.limit(1),
		);
		if (
			!currentOrganization ||
			currentOrganization.tombstoneAt ||
			(currentOrganization.ownerId !== user.id && actor?.role !== "admin")
		)
			throw new Error("Only an organization manager can invite members.");
		const existingInvites = await snapshot.read((reader) =>
			reader
				.select({ email: organizationInvites.invitedEmail })
				.from(organizationInvites)
				.where(
					and(
						eq(organizationInvites.organizationId, organizationId),
						inArray(organizationInvites.invitedEmail, validEmails),
					),
				),
		);
		const existingMembers = await snapshot.read((reader) =>
			reader
				.select({ email: users.email })
				.from(organizationMembers)
				.innerJoin(users, eq(organizationMembers.userId, users.id))
				.where(
					and(
						eq(organizationMembers.organizationId, organizationId),
						inArray(users.email, validEmails),
					),
				),
		);
		const existing = new Set(
			[...existingInvites, ...existingMembers].map((row) =>
				normalizeEmail(row.email),
			),
		);
		const records = proposed.filter((invite) => !existing.has(invite.email));
		const statements: AtomicStatement[] = [];
		for (let offset = 0; offset < records.length; offset += 10)
			statements.push(
				database.insert(organizationInvites).values(
					records.slice(offset, offset + 10).map((record) => ({
						id: record.id,
						organizationId,
						invitedEmail: record.email,
						invitedByUserId: user.id,
						role: record.role,
					})),
				),
			);
		return { statements, result: records };
	});

	const emailResults = await Promise.allSettled(
		inviteRecords.map((record) => {
			const inviteUrl = `${serverEnv().WEB_URL}/invite/${record.id}`;
			return sendEmail({
				email: record.email,
				subject: `Invitation to join ${organization.name} on Cap`,
				react: OrganizationInvite({
					email: record.email,
					url: inviteUrl,
					organizationName: organization.name,
				}),
			});
		}),
	);

	const failedInvites = inviteRecords.filter((_, i) => {
		const result = emailResults[i];
		if (!result || result.status === "rejected") return true;
		const error = result.value?.error;
		return Boolean(error && error.name !== "email_not_configured");
	});
	const failedEmails = failedInvites.map((r) => r.email);
	const skippedEmails = inviteRecords
		.filter((_, i) => {
			const result = emailResults[i];
			return (
				result?.status === "fulfilled" &&
				result.value?.error?.name === "email_not_configured"
			);
		})
		.map((record) => record.email);

	if (failedInvites.length > 0) {
		try {
			await db()
				.delete(organizationInvites)
				.where(
					inArray(
						organizationInvites.id,
						failedInvites.map((r) => r.id),
					),
				);
		} catch (cleanupError) {
			console.error(
				"Failed to clean up invite records after email delivery failure:",
				{
					failedInviteIds: failedInvites.map((r) => r.id),
					failedEmails,
					error: cleanupError,
				},
			);
		}
	}

	revalidatePath("/dashboard/settings/organization");

	return { success: true, failedEmails, skippedEmails };
}
