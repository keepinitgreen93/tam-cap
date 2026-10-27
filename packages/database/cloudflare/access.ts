import type { Organisation, User } from "@cap/web-domain";
import { and, eq, gt, isNull, notExists, or } from "drizzle-orm";
import { normalizeEmail } from "../auth/identity.ts";
import type { AtomicSnapshot, SnapshotReader } from "./atomic.ts";
import {
	accounts,
	organizationInvites,
	organizationMembers,
	organizations,
	users,
	videoProcessingJobs,
	videos,
	videoViewerGrants,
} from "./schema.ts";

export class WorkspaceAccountRequiredError extends Error {
	constructor() {
		super("Workspace membership is required");
		this.name = "WorkspaceAccountRequiredError";
	}
}

export type AccountCapability =
	| {
			kind: "workspace" | "viewer" | "invited";
			user: typeof users.$inferSelect;
	  }
	| { kind: "none"; user: typeof users.$inferSelect | null };

export async function hasPendingOrganizationInvite(
	reader: SnapshotReader,
	email: string,
) {
	const [invite] = await reader
		.select({ id: organizationInvites.id })
		.from(organizationInvites)
		.innerJoin(
			organizations,
			eq(organizations.id, organizationInvites.organizationId),
		)
		.where(
			and(
				eq(organizationInvites.invitedEmail, normalizeEmail(email)),
				eq(organizationInvites.status, "pending"),
				or(
					isNull(organizationInvites.expiresAt),
					gt(organizationInvites.expiresAt, new Date()),
				),
				isNull(organizations.tombstoneAt),
			),
		)
		.limit(1);
	return Boolean(invite);
}

export async function hasActiveViewerGrant(
	reader: SnapshotReader,
	email: string,
) {
	const deleting = reader
		.select({ id: videoProcessingJobs.videoId })
		.from(videoProcessingJobs)
		.where(
			and(
				eq(videoProcessingJobs.videoId, videos.id),
				eq(videoProcessingJobs.errorCode, "video-deleting"),
			),
		);
	const [grant] = await reader
		.select({ id: videoViewerGrants.id })
		.from(videoViewerGrants)
		.innerJoin(videos, eq(videos.id, videoViewerGrants.videoId))
		.innerJoin(organizations, eq(organizations.id, videos.orgId))
		.where(
			and(
				eq(videoViewerGrants.email, normalizeEmail(email)),
				isNull(videoViewerGrants.revokedAt),
				isNull(organizations.tombstoneAt),
				notExists(deleting),
			),
		)
		.limit(1);
	return Boolean(grant);
}

export async function hasWorkspaceAccess(
	reader: SnapshotReader,
	user: typeof users.$inferSelect,
	ownerEmail = process.env.CAP_OWNER_EMAIL ??
		"hello@trulyauthenticmarketing.com",
) {
	if (normalizeEmail(user.email) === normalizeEmail(ownerEmail)) return true;
	if (!user.emailVerified) {
		const [account] = await reader
			.select({ id: accounts.id })
			.from(accounts)
			.where(eq(accounts.userId, user.id))
			.limit(1);
		if (!account) return false;
	}
	const [membership] = await reader
		.select({ id: organizations.id })
		.from(organizations)
		.leftJoin(
			organizationMembers,
			and(
				eq(organizationMembers.organizationId, organizations.id),
				eq(organizationMembers.userId, user.id),
			),
		)
		.where(
			and(
				isNull(organizations.tombstoneAt),
				or(
					eq(organizations.ownerId, user.id),
					eq(organizationMembers.userId, user.id),
				),
			),
		)
		.limit(1);
	return Boolean(membership);
}

export async function getAccountCapability(
	snapshot: AtomicSnapshot,
	userId: User.UserId,
): Promise<AccountCapability> {
	const [user] = await snapshot.read((reader) =>
		reader.select().from(users).where(eq(users.id, userId)).limit(1),
	);
	if (!user) return { kind: "none", user: null };
	if (await snapshot.read((reader) => hasWorkspaceAccess(reader, user)))
		return { kind: "workspace", user };
	if (await snapshot.read((reader) => hasActiveViewerGrant(reader, user.email)))
		return { kind: "viewer", user };
	if (
		await snapshot.read((reader) =>
			hasPendingOrganizationInvite(reader, user.email),
		)
	)
		return { kind: "invited", user };
	return { kind: "none", user };
}

export async function requireWorkspaceAccount(
	snapshot: AtomicSnapshot,
	userId: User.UserId,
) {
	const capability = await getAccountCapability(snapshot, userId);
	if (capability.kind !== "workspace")
		throw new WorkspaceAccountRequiredError();
	return capability.user;
}

export async function requireActiveOrganization(
	snapshot: AtomicSnapshot,
	organizationId: Organisation.OrganisationId,
) {
	const [organization] = await snapshot.read((reader) =>
		reader
			.select()
			.from(organizations)
			.where(
				and(
					eq(organizations.id, organizationId),
					isNull(organizations.tombstoneAt),
				),
			)
			.limit(1),
	);
	if (!organization)
		throw new Error("Organization is unavailable or being deleted");
	return organization;
}

export async function requireOrganizationMember(
	snapshot: AtomicSnapshot,
	organizationId: Organisation.OrganisationId,
	userId: User.UserId,
) {
	const organization = await requireActiveOrganization(
		snapshot,
		organizationId,
	);
	const [member] = await snapshot.read((reader) =>
		reader
			.select()
			.from(organizationMembers)
			.where(
				and(
					eq(organizationMembers.organizationId, organizationId),
					eq(organizationMembers.userId, userId),
				),
			)
			.limit(1),
	);
	if (organization.ownerId !== userId && !member)
		throw new Error("Organization membership is required");
	const role =
		organization.ownerId === userId
			? "owner"
			: member?.role === "admin"
				? "admin"
				: "member";
	return { organization, member, role };
}

export async function requireOrganizationManager(
	snapshot: AtomicSnapshot,
	organizationId: Organisation.OrganisationId,
	userId: User.UserId,
) {
	const access = await requireOrganizationMember(
		snapshot,
		organizationId,
		userId,
	);
	if (access.role === "member")
		throw new Error(
			"Only organization owners and admins can manage this resource",
		);
	return access;
}
