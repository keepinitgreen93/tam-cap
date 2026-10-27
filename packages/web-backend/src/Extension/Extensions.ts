import { requireWorkspaceAccount } from "@cap/database/cloudflare/access";
import { atomic } from "@cap/database/cloudflare/atomic";
import * as Db from "@cap/database/cloudflare/schema";
import { userIsPro } from "@cap/utils";
import type { Organisation, User } from "@cap/web-domain";
import * as Dz from "drizzle-orm";
import { Data, Effect, Option } from "effect";

import { CloudflareDatabase as Database } from "../CloudflareDatabase.ts";

// Auth keys are minted by a GET navigation, so a forced cross-site navigation
// could otherwise spam rows; cap how many keys one user can mint per window.
const AUTH_KEY_MINT_WINDOW_MS = 60 * 60 * 1000;
const AUTH_KEY_MINT_LIMIT = 10;

export class AuthKeyMintRateLimited extends Data.TaggedError(
	"AuthKeyMintRateLimited",
) {}

export class Extensions extends Effect.Service<Extensions>()("Extensions", {
	effect: Effect.gen(function* () {
		const db = yield* Database;

		const selectOwnedOrganization = (where: Dz.SQL) =>
			db.use((db) =>
				db
					.select({
						id: Db.organizations.id,
						name: Db.organizations.name,
					})
					.from(Db.organizations)
					.innerJoin(Db.users, Dz.eq(Db.organizations.ownerId, Db.users.id))
					.where(where)
					// Deterministic fallback selection: this result can be persisted
					// as the user's activeOrganizationId below, so an unordered
					// LIMIT 1 would let the active org flap between requests.
					.orderBy(Dz.asc(Db.organizations.id))
					.limit(1),
			);

		return {
			isUserPro: Effect.fn("Extensions.isUserPro")(function* (
				userId: User.UserId,
			) {
				const [user] = yield* db.use((db) =>
					db
						.select({
							stripeSubscriptionStatus: Db.users.stripeSubscriptionStatus,
							thirdPartyStripeSubscriptionId:
								Db.users.thirdPartyStripeSubscriptionId,
						})
						.from(Db.users)
						.where(Dz.eq(Db.users.id, userId))
						.limit(1),
				);

				return userIsPro(user ?? null);
			}),

			mintAuthKey: Effect.fn("Extensions.mintAuthKey")(function* (
				userId: User.UserId,
			) {
				const authApiKey = crypto.randomUUID();
				const mintedSince = new Date(Date.now() - AUTH_KEY_MINT_WINDOW_MS);
				const minted = yield* db.use((database) =>
					atomic(database, async (snapshot) => {
						await requireWorkspaceAccount(snapshot, userId);
						const recent = await snapshot.read((reader) =>
							reader
								.select({ id: Db.authApiKeys.id })
								.from(Db.authApiKeys)
								.where(
									Dz.and(
										Dz.eq(Db.authApiKeys.userId, userId),
										Dz.gt(Db.authApiKeys.createdAt, mintedSince),
									),
								)
								.limit(AUTH_KEY_MINT_LIMIT),
						);
						if (recent.length >= AUTH_KEY_MINT_LIMIT)
							return { statements: [], result: false };
						return {
							statements: [
								database
									.insert(Db.authApiKeys)
									.values({ id: authApiKey, userId, source: "extension" }),
							],
							result: true,
						};
					}),
				);
				if (!minted) return yield* Effect.fail(new AuthKeyMintRateLimited());
				return authApiKey;
			}),

			revokeAuthKey: Effect.fn("Extensions.revokeAuthKey")(function* (
				userId: User.UserId,
				authApiKey: string,
			) {
				yield* db.use((db) =>
					db
						.delete(Db.authApiKeys)
						.where(
							Dz.and(
								Dz.eq(Db.authApiKeys.id, authApiKey),
								Dz.eq(Db.authApiKeys.userId, userId),
							),
						),
				);
			}),

			resolveBootstrapOrganization: Effect.fn(
				"Extensions.resolveBootstrapOrganization",
			)(function* (user: {
				id: User.UserId;
				activeOrganizationId: Organisation.OrganisationId;
			}) {
				let [organization] = yield* selectOwnedOrganization(
					Dz.eq(Db.organizations.id, user.activeOrganizationId),
				);

				// A dangling activeOrganizationId (deleted org, revoked
				// membership) must not brick the extension; fall back to an
				// organization the user owns, then to one they are a member
				// of.
				if (!organization) {
					[organization] = yield* selectOwnedOrganization(
						Dz.eq(Db.organizations.ownerId, user.id),
					);
				}

				if (!organization) {
					const [viaMembership] = yield* db.use((db) =>
						db
							.select({
								id: Db.organizations.id,
								name: Db.organizations.name,
							})
							.from(Db.organizationMembers)
							.innerJoin(
								Db.organizations,
								Dz.eq(
									Db.organizationMembers.organizationId,
									Db.organizations.id,
								),
							)
							.innerJoin(Db.users, Dz.eq(Db.organizations.ownerId, Db.users.id))
							.where(Dz.eq(Db.organizationMembers.userId, user.id))
							// Oldest membership first, with the org id as a stable
							// tie-break — same determinism requirement as above.
							.orderBy(
								Dz.asc(Db.organizationMembers.createdAt),
								Dz.asc(Db.organizations.id),
							)
							.limit(1),
					);
					organization = viaMembership;
				}

				// Repair the dangling pointer: createInstantRecording rejects any
				// org that is not the user's activeOrganizationId, so returning a
				// fallback org without persisting it would let bootstrap succeed
				// while every recording create fails PolicyDenied.
				const resolved = organization;
				if (resolved && resolved.id !== user.activeOrganizationId) {
					yield* db.use((db) =>
						db
							.update(Db.users)
							.set({ activeOrganizationId: resolved.id })
							.where(Dz.eq(Db.users.id, user.id)),
					);
				}

				return Option.fromNullable(resolved);
			}),
		};
	}),
	dependencies: [Database.Default],
}) {}
