import "server-only";

import { normalizeEmail } from "@cap/database/auth/identity";
import { db } from "@cap/database/cloudflare/application";
import {
	organizationInvites,
	organizations,
	users,
} from "@cap/database/cloudflare/schema";
import { and, asc, eq, gt, isNull, or } from "drizzle-orm";

const activeInvitation = (now: Date) =>
	and(
		eq(organizationInvites.status, "pending"),
		or(
			isNull(organizationInvites.expiresAt),
			gt(organizationInvites.expiresAt, now),
		),
		isNull(organizations.tombstoneAt),
	);

export async function getPendingInviteIdForUser(email: string) {
	const [invite] = await db()
		.select({ id: organizationInvites.id })
		.from(organizationInvites)
		.innerJoin(
			organizations,
			eq(organizationInvites.organizationId, organizations.id),
		)
		.where(
			and(
				eq(organizationInvites.invitedEmail, normalizeEmail(email)),
				activeInvitation(new Date()),
			),
		)
		.orderBy(asc(organizationInvites.createdAt), asc(organizationInvites.id))
		.limit(1);
	return invite?.id ?? null;
}

export async function getInviteDetails(inviteId: string) {
	const [invite] = await db()
		.select({
			invite: organizationInvites,
			organizationName: organizations.name,
			inviterName: users.name,
		})
		.from(organizationInvites)
		.innerJoin(
			organizations,
			eq(organizationInvites.organizationId, organizations.id),
		)
		.leftJoin(users, eq(organizationInvites.invitedByUserId, users.id))
		.where(
			and(eq(organizationInvites.id, inviteId), activeInvitation(new Date())),
		)
		.limit(1);
	return invite;
}
