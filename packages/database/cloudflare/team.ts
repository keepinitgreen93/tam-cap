import type { ImageUpload, Organisation, User } from "@cap/web-domain";
import {
	and,
	eq,
	exists,
	gt,
	inArray,
	isNotNull,
	isNull,
	ne,
	or,
} from "drizzle-orm";
import type { Adapter } from "next-auth/adapters";
import { normalizeEmail } from "../auth/identity.ts";
import { nanoId } from "../helpers.ts";
import {
	hasActiveViewerGrant,
	hasPendingOrganizationInvite,
	hasWorkspaceAccess,
} from "./access.ts";
import { type AtomicStatement, atomic, type SnapshotReader } from "./atomic.ts";
import type { CloudflareDatabase } from "./index.ts";
import { loopsSyncStatements } from "./loops.ts";
import { releaseProSeatStatement } from "./pro-seat.ts";
import {
	accounts,
	organizationInvites,
	organizationMembers,
	organizations,
	spaceMembers,
	spaces,
	users,
} from "./schema.ts";

type CreateUserData = Parameters<NonNullable<Adapter["createUser"]>>[0];
export type TeamAccessPolicy = { ownerEmail: string; inviteOnly: true };

export async function canSignInCloudflare(
	database: SnapshotReader,
	email: string,
	policy: TeamAccessPolicy,
): Promise<boolean> {
	const normalized = normalizeEmail(email);
	if (normalized === normalizeEmail(policy.ownerEmail)) return true;
	if (await hasPendingOrganizationInvite(database, normalized)) return true;
	if (await hasActiveViewerGrant(database, normalized)) return true;
	const [user] = await database
		.select()
		.from(users)
		.where(eq(users.email, normalized))
		.limit(1);
	return user ? hasWorkspaceAccess(database, user, policy.ownerEmail) : false;
}
export async function resolveCloudflareInvite(
	database: CloudflareDatabase,
	input: { userId: User.UserId; inviteId: string; accept: boolean },
) {
	const memberId = nanoId();
	const now = new Date();
	await atomic(database, async (snapshot) => {
		const [user] = await snapshot.read((reader) =>
			reader.select().from(users).where(eq(users.id, input.userId)).limit(1),
		);
		const [invite] = await snapshot.read((reader) =>
			reader
				.select()
				.from(organizationInvites)
				.where(eq(organizationInvites.id, input.inviteId))
				.limit(1),
		);
		if (!user || !invite) throw new Error("INVITE_NOT_FOUND");
		if (normalizeEmail(user.email) !== normalizeEmail(invite.invitedEmail))
			throw new Error("EMAIL_MISMATCH");
		if (
			invite.status !== "pending" ||
			(invite.expiresAt && invite.expiresAt <= now)
		)
			throw new Error("INVITE_EXPIRED");
		const [organization] = await snapshot.read((reader) =>
			reader
				.select()
				.from(organizations)
				.where(
					and(
						eq(organizations.id, invite.organizationId),
						isNull(organizations.tombstoneAt),
					),
				)
				.limit(1),
		);
		if (!organization) throw new Error("INVITE_NOT_FOUND");
		const [member] = await snapshot.read((reader) =>
			reader
				.select()
				.from(organizationMembers)
				.where(
					and(
						eq(organizationMembers.organizationId, invite.organizationId),
						eq(organizationMembers.userId, user.id),
					),
				)
				.limit(1),
		);
		const statements: AtomicStatement[] = [];
		if (input.accept) {
			if (!member)
				statements.push(
					database.insert(organizationMembers).values({
						id: memberId,
						organizationId: invite.organizationId,
						userId: user.id,
						role: invite.role === "admin" ? "admin" : "member",
					}),
				);
			statements.push(
				database
					.update(users)
					.set({
						activeOrganizationId: invite.organizationId,
						defaultOrgId: user.defaultOrgId || invite.organizationId,
						marketingOrigin: "teammate",
						onboardingSteps: {
							...user.onboardingSteps,
							organizationSetup: true,
							customDomain: true,
							inviteTeam: true,
						},
					})
					.where(eq(users.id, user.id)),
				...loopsSyncStatements(database, user.id, true),
			);
		} else if (member) {
			if (organization.ownerId === user.id)
				throw new Error(
					"Cannot remove an organization owner through an invitation.",
				);
			const [remaining] = await snapshot.read((reader) =>
				reader
					.select({ id: organizationMembers.organizationId })
					.from(organizationMembers)
					.where(
						and(
							eq(organizationMembers.userId, user.id),
							ne(organizationMembers.organizationId, invite.organizationId),
						),
					)
					.limit(1),
			);
			statements.push(
				database
					.delete(organizationMembers)
					.where(eq(organizationMembers.id, member.id)),
			);
			if (member.hasProSeat)
				statements.push(releaseProSeatStatement(database, user.id));
			statements.push(
				database
					.delete(spaceMembers)
					.where(
						and(
							eq(spaceMembers.userId, user.id),
							inArray(
								spaceMembers.spaceId,
								database
									.select({ id: spaces.id })
									.from(spaces)
									.where(eq(spaces.organizationId, invite.organizationId)),
							),
						),
					),
			);
			if (
				user.activeOrganizationId === invite.organizationId ||
				user.defaultOrgId === invite.organizationId
			)
				statements.push(
					database
						.update(users)
						.set({
							...(user.activeOrganizationId === invite.organizationId
								? {
										activeOrganizationId:
											remaining?.id ?? ("" as Organisation.OrganisationId),
									}
								: {}),
							...(user.defaultOrgId === invite.organizationId
								? { defaultOrgId: remaining?.id ?? null }
								: {}),
						})
						.where(eq(users.id, user.id)),
				);
		}
		statements.push(
			database
				.delete(organizationInvites)
				.where(eq(organizationInvites.id, input.inviteId)),
		);
		return { statements, result: undefined };
	});
}

export async function createCloudflareUser(
	database: CloudflareDatabase,
	input: CreateUserData,
	policy: TeamAccessPolicy,
) {
	const email = normalizeEmail(input.email);
	const generatedUserId = nanoId() as User.UserId;
	const organizationId = nanoId() as Organisation.OrganisationId;
	const memberId = nanoId();
	const userId = await atomic(database, async (snapshot) => {
		if (
			!(await snapshot.read((reader) =>
				canSignInCloudflare(reader, email, policy),
			))
		)
			throw new Error(
				"An owner invitation is required to create this account.",
			);
		const [existing] = await snapshot.read((reader) =>
			reader.select().from(users).where(eq(users.email, email)).limit(1),
		);
		if (existing) {
			return {
				statements: [
					database
						.update(users)
						.set({
							name: existing.name || input.name || email.split("@")[0],
							emailVerified: existing.emailVerified ?? input.emailVerified,
							image:
								existing.image ||
								(input.image as ImageUpload.ImageUrlOrKey | null),
						})
						.where(eq(users.id, existing.id)),
					...loopsSyncStatements(database, existing.id),
				],
				result: existing.id,
			};
		}
		const isOwner = email === normalizeEmail(policy.ownerEmail);
		const statements: AtomicStatement[] = [
			database.insert(users).values({
				id: generatedUserId,
				email,
				emailVerified: input.emailVerified,
				name: input.name || email.split("@")[0],
				image: input.image as ImageUpload.ImageUrlOrKey | null,
				activeOrganizationId: isOwner
					? organizationId
					: ("" as Organisation.OrganisationId),
				defaultOrgId: isOwner ? organizationId : null,
				marketingOrigin: isOwner ? "independent" : "teammate",
			}),
		];
		if (isOwner)
			statements.push(
				database.insert(organizations).values({
					id: organizationId,
					ownerId: generatedUserId,
					name: "My Organization",
				}),
				database.insert(organizationMembers).values({
					id: memberId,
					organizationId,
					userId: generatedUserId,
					role: "owner",
				}),
			);
		statements.push(...loopsSyncStatements(database, generatedUserId));
		return { statements, result: generatedUserId };
	});
	const [user] = await database
		.select()
		.from(users)
		.where(eq(users.id, userId))
		.limit(1);
	if (!user) throw new Error("User was not created.");
	return user;
}

export async function provisionCloudflareInvitee(
	database: CloudflareDatabase,
	input: {
		organizationId: Organisation.OrganisationId;
		email: string;
		invitedByUserId: User.UserId;
		role: "admin" | "member";
	},
) {
	const email = normalizeEmail(input.email);
	const generatedUserId = nanoId() as User.UserId;
	const generatedMemberId = nanoId();
	const generatedInviteId = nanoId();
	return atomic(database, async (snapshot) => {
		const [organization] = await snapshot.read((reader) =>
			reader
				.select()
				.from(organizations)
				.where(
					and(
						eq(organizations.id, input.organizationId),
						isNull(organizations.tombstoneAt),
					),
				)
				.limit(1),
		);
		const [actor] = await snapshot.read((reader) =>
			reader
				.select()
				.from(organizationMembers)
				.where(
					and(
						eq(organizationMembers.organizationId, input.organizationId),
						eq(organizationMembers.userId, input.invitedByUserId),
					),
				)
				.limit(1),
		);
		if (
			!organization ||
			(organization.ownerId !== input.invitedByUserId &&
				actor?.role !== "admin")
		)
			throw new Error("Only an organization manager can invite members.");
		const [existing] = await snapshot.read((reader) =>
			reader.select().from(users).where(eq(users.email, email)).limit(1),
		);
		const userId = existing?.id ?? generatedUserId;
		const [member] = await snapshot.read((reader) =>
			reader
				.select()
				.from(organizationMembers)
				.where(
					and(
						eq(organizationMembers.organizationId, input.organizationId),
						eq(organizationMembers.userId, userId),
					),
				)
				.limit(1),
		);
		const [invite] = await snapshot.read((reader) =>
			reader
				.select()
				.from(organizationInvites)
				.where(
					and(
						eq(organizationInvites.organizationId, input.organizationId),
						eq(organizationInvites.invitedEmail, email),
					),
				)
				.limit(1),
		);
		const statements: AtomicStatement[] = [];
		if (existing)
			statements.push(
				database
					.update(users)
					.set({
						name: existing.name || email.split("@")[0],
						marketingOrigin: "teammate",
						activeOrganizationId:
							existing.activeOrganizationId || input.organizationId,
						defaultOrgId: existing.defaultOrgId || input.organizationId,
					})
					.where(eq(users.id, userId)),
			);
		else
			statements.push(
				database.insert(users).values({
					id: userId,
					email,
					name: email.split("@")[0],
					marketingOrigin: "teammate",
					activeOrganizationId: input.organizationId,
					defaultOrgId: input.organizationId,
				}),
			);
		if (!member) {
			statements.push(
				database.insert(organizationMembers).values({
					id: generatedMemberId,
					userId,
					organizationId: input.organizationId,
					role: input.role,
				}),
			);
			if (!invite)
				statements.push(
					database.insert(organizationInvites).values({
						id: generatedInviteId,
						organizationId: input.organizationId,
						invitedEmail: email,
						invitedByUserId: input.invitedByUserId,
						role: input.role,
					}),
				);
		}
		return {
			statements: [...statements, ...loopsSyncStatements(database, userId)],
			result: {
				userId,
				memberId: member?.id ?? generatedMemberId,
				inviteId: member ? null : (invite?.id ?? generatedInviteId),
				hasProSeat: member?.hasProSeat ?? false,
				userCreated: !existing,
				memberCreated: !member,
				inviteCreated: !member && !invite,
			},
		};
	});
}
