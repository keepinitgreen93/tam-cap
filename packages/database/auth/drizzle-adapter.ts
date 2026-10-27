import { createHash } from "node:crypto";

import type { ImageUpload, User } from "@cap/web-domain";
import { and, eq } from "drizzle-orm";
import type { Adapter } from "next-auth/adapters";
import { atomic } from "../cloudflare/atomic.ts";
import type { CloudflareDatabase } from "../cloudflare/index.ts";
import { loopsSyncStatements } from "../cloudflare/loops.ts";
import {
	accounts,
	organizationInvites,
	organizationMembers,
	organizations,
	sessions,
	users,
	verificationTokens,
} from "../cloudflare/schema.ts";
import { createCloudflareUser } from "../cloudflare/team.ts";
import { nanoId } from "../helpers.ts";
import { cloudflareAccessPolicy, normalizeEmail } from "./identity.ts";
import type { ValidatedSsoIdentity } from "./sso.ts";

type CreateUserData = Parameters<NonNullable<Adapter["createUser"]>>[0];
type LinkAccountData = Parameters<NonNullable<Adapter["linkAccount"]>>[0];
type UnlinkAccountData = Parameters<NonNullable<Adapter["unlinkAccount"]>>[0];
type UpdateSessionData = Parameters<NonNullable<Adapter["updateSession"]>>[0];

async function hasPendingProvisionedInvite(
	db: CloudflareDatabase,
	userId: User.UserId,
	email: string,
) {
	const [pendingInviteMember] = await db
		.select({ inviteId: organizationInvites.id })
		.from(organizationInvites)
		.innerJoin(
			organizationMembers,
			and(
				eq(
					organizationMembers.organizationId,
					organizationInvites.organizationId,
				),
				eq(organizationMembers.userId, userId),
			),
		)
		.where(
			and(
				eq(organizationInvites.invitedEmail, email),
				eq(organizationInvites.status, "pending"),
			),
		)
		.limit(1);

	return !!pendingInviteMember;
}

async function hasLinkedAccount(db: CloudflareDatabase, userId: User.UserId) {
	const [linkedAccount] = await db
		.select({ id: accounts.id })
		.from(accounts)
		.where(eq(accounts.userId, userId))
		.limit(1);

	return !!linkedAccount;
}

export function DrizzleAdapter(
	db: CloudflareDatabase,
	options?: { getSsoIdentity: () => ValidatedSsoIdentity | null },
): Adapter {
	return {
		async createUser(userData: CreateUserData) {
			const identity = options?.getSsoIdentity();
			if (
				identity &&
				normalizeEmail(identity.email) !== normalizeEmail(userData.email)
			)
				throw new Error("The user does not match the verified SSO identity.");
			return createCloudflareUser(db, userData, cloudflareAccessPolicy());
		},
		async getUser(id) {
			const rows = await db
				.select()
				.from(users)
				.where(eq(users.id, id as User.UserId))
				.limit(1);
			const row = rows[0];
			return row ?? null;
		},
		async getUserByEmail(email) {
			const normalizedEmail = normalizeEmail(email);
			const rows = await db
				.select()
				.from(users)
				.where(eq(users.email, normalizedEmail))
				.limit(1)
				.catch((e) => {
					throw e;
				});
			const row = rows[0];
			if (!row) return null;

			if (
				!(await hasLinkedAccount(db, row.id)) &&
				(await hasPendingProvisionedInvite(db, row.id, normalizedEmail))
			) {
				return null;
			}

			return row;
		},
		async getUserByAccount({ providerAccountId, provider }) {
			const rows = await db
				.select()
				.from(users)
				.innerJoin(accounts, eq(users.id, accounts.userId))
				.where(
					and(
						eq(accounts.providerAccountId, providerAccountId),
						eq(accounts.provider, provider),
					),
				)
				.limit(1);
			const row = rows[0];
			return row?.users ?? null;
		},
		async updateUser({ id, image, ...userData }) {
			if (!id) throw new Error("User not found");
			const update = db
				.update(users)
				.set({
					...userData,
					...(userData.email ? { email: normalizeEmail(userData.email) } : {}),
					image: image as ImageUpload.ImageUrlOrKey | null,
				})
				.where(eq(users.id, id as User.UserId));
			await atomic(db, async () => ({
				statements: [update, ...loopsSyncStatements(db, id as User.UserId)],
				result: undefined,
			}));
			const [row] = await db
				.select()
				.from(users)
				.where(eq(users.id, id as User.UserId))
				.limit(1);
			if (!row) throw new Error("User not found");
			return row;
		},
		async deleteUser(userId) {
			await db.delete(users).where(eq(users.id, userId as User.UserId));
		},
		async linkAccount(account: LinkAccountData) {
			const identity = options?.getSsoIdentity();
			if (
				account.provider === "workos" &&
				(!identity || identity.profileId !== account.providerAccountId)
			)
				throw new Error("The SSO identity has not been verified.");
			const accountId = createHash("sha256")
				.update(`${account.provider}:${account.providerAccountId}`)
				.digest("base64url")
				.slice(0, 15);
			await atomic(db, async (snapshot) => {
				const [user] = await snapshot.read((reader) =>
					reader
						.select()
						.from(users)
						.where(eq(users.id, account.userId as User.UserId))
						.limit(1),
				);
				if (!user) throw new Error("User not found");
				if (account.provider === "workos" && identity) {
					const [organization] = await snapshot.read((reader) =>
						reader
							.select()
							.from(organizations)
							.where(eq(organizations.id, identity.organizationId))
							.limit(1),
					);
					if (
						!organization ||
						organization.tombstoneAt ||
						normalizeEmail(user.email) !== normalizeEmail(identity.email)
					)
						throw new Error(
							"The SSO account belongs to a different user or unavailable organization.",
						);
				}
				const linked = await snapshot.read((reader) =>
					reader
						.select({ userId: accounts.userId })
						.from(accounts)
						.where(
							and(
								eq(accounts.provider, account.provider),
								eq(accounts.providerAccountId, account.providerAccountId),
							),
						)
						.limit(2),
				);
				if (linked.some((row) => row.userId !== account.userId))
					throw new Error("The identity is already linked to another account.");
				return {
					statements: linked.length
						? []
						: [
								db.insert(accounts).values({
									id: accountId,
									userId: account.userId,
									type: account.type,
									provider: account.provider,
									providerAccountId: account.providerAccountId,
									access_token: account.access_token,
									expires_in: account.expires_in as number,
									id_token: account.id_token,
									refresh_token: account.refresh_token,
									refresh_token_expires_in:
										account.refresh_token_expires_in as number,
									scope: account.scope,
									token_type: account.token_type,
								}),
							],
					result: undefined,
				};
			});
		},
		async unlinkAccount({ providerAccountId, provider }: UnlinkAccountData) {
			await db
				.delete(accounts)
				.where(
					and(
						eq(accounts.providerAccountId, providerAccountId),
						eq(accounts.provider, provider),
					),
				);
		},
		async createSession(data) {
			await db.insert(sessions).values({
				id: nanoId(),
				expires: data.expires,
				sessionToken: data.sessionToken,
				userId: data.userId as User.UserId,
			});
			const rows = await db
				.select()
				.from(sessions)
				.where(eq(sessions.sessionToken, data.sessionToken))
				.limit(1);
			const row = rows[0];
			if (!row) throw new Error("User not found");
			return row;
		},
		async getSessionAndUser(sessionToken) {
			const rows = await db
				.select({
					user: users,
					session: {
						id: sessions.id,
						userId: sessions.userId,
						sessionToken: sessions.sessionToken,
						expires: sessions.expires,
					},
				})
				.from(sessions)
				.innerJoin(users, eq(users.id, sessions.userId))
				.where(eq(sessions.sessionToken, sessionToken))
				.limit(1);
			const row = rows[0];
			if (!row) return null;
			const { user, session } = row;
			return {
				user,
				session: {
					id: session.id,
					userId: session.userId as User.UserId,
					sessionToken: session.sessionToken,
					expires: session.expires,
				},
			};
		},
		async updateSession(session: UpdateSessionData) {
			const sessionUpdate: Partial<typeof sessions.$inferInsert> = {};
			if (session.expires) sessionUpdate.expires = session.expires;
			if (session.userId) sessionUpdate.userId = session.userId as User.UserId;

			if (Object.keys(sessionUpdate).length > 0) {
				await db
					.update(sessions)
					.set(sessionUpdate)
					.where(eq(sessions.sessionToken, session.sessionToken));
			}
			const rows = await db
				.select()
				.from(sessions)
				.where(eq(sessions.sessionToken, session.sessionToken))
				.limit(1);
			const row = rows[0];
			if (!row) throw new Error("Coding bug: updated session not found");
			return row;
		},
		async deleteSession(sessionToken) {
			await db.delete(sessions).where(eq(sessions.sessionToken, sessionToken));
		},
		async createVerificationToken(input) {
			const value = { ...input, identifier: normalizeEmail(input.identifier) };
			const [token] = await db
				.insert(verificationTokens)
				.values(value)
				.onConflictDoUpdate({
					target: verificationTokens.identifier,
					set: { token: value.token, expires: value.expires },
				})
				.returning();
			if (!token) throw new Error("Verification token was not created");
			return token;
		},
		async useVerificationToken({ identifier, token }) {
			const normalizedIdentifier = normalizeEmail(identifier);
			const rows = await db
				.select()
				.from(verificationTokens)
				.where(eq(verificationTokens.identifier, normalizedIdentifier))
				.limit(1);
			const row = rows[0];
			if (!row) {
				console.warn("[useVerificationToken] No token found");
				return null;
			}
			// Claim the exact row we just read (identifier + token) with a single
			// delete, and only proceed if we actually removed it. This makes
			// consumption atomic: concurrent requests race on the same delete, so
			// at most one of them can claim the row, whether the guess is right or
			// wrong. Scoping by token too (not identifier alone) means the delete
			// can't clobber a resend that replaced this row after we read it.
			const result = await db
				.delete(verificationTokens)
				.where(
					and(
						eq(verificationTokens.identifier, row.identifier),
						eq(verificationTokens.token, row.token),
					),
				);
			if (result.meta.changes !== 1) {
				console.warn("[useVerificationToken] Token already consumed");
				return null;
			}
			if (row.token !== token) {
				console.warn("[useVerificationToken] Token mismatch");
				return null;
			}
			return { ...row, identifier: normalizedIdentifier };
		},
	};
}
