import * as Db from "@cap/database/cloudflare/schema";
import { userIsPro } from "@cap/utils";
import {
	CurrentUser,
	Folder,
	Organisation,
	Policy,
	type Space,
	User,
} from "@cap/web-domain";
import * as Dz from "drizzle-orm";
import { Effect, Option } from "effect";

import { CloudflareDatabase as Database } from "../CloudflareDatabase.ts";
import { FoldersPolicy } from "./FoldersPolicy.ts";
import { FoldersRepo } from "./FoldersRepo.ts";

// @effect-diagnostics-next-line leakingRequirements:off
export class Folders extends Effect.Service<Folders>()("Folders", {
	effect: Effect.gen(function* () {
		const db = yield* Database;
		const policy = yield* FoldersPolicy;
		const repo = yield* FoldersRepo;

		/**
		 * Making a collection public is a Pro feature, gated on the organization
		 * OWNER's plan (any manager can publish while the owner is Pro). Disabling
		 * public never requires Pro, so a downgraded org can always un-publish.
		 */
		const requireOwnerPro = (organizationId: Organisation.OrganisationId) =>
			Effect.gen(function* () {
				const [owner] = yield* db.use((db) =>
					db
						.select({
							stripeSubscriptionStatus: Db.users.stripeSubscriptionStatus,
							thirdPartyStripeSubscriptionId:
								Db.users.thirdPartyStripeSubscriptionId,
						})
						.from(Db.organizations)
						.innerJoin(Db.users, Dz.eq(Db.organizations.ownerId, Db.users.id))
						.where(Dz.eq(Db.organizations.id, organizationId))
						.limit(1),
				);

				if (!userIsPro(owner ?? null))
					return yield* new Policy.PolicyDeniedError({
						reason: "Upgrade to Cap Pro to create a public collection link",
					});
			});

		return {
			create: Effect.fn("Folders.create")(function* (data: {
				name: string;
				color: Folder.FolderColor;
				public?: boolean;
				spaceId: Option.Option<Space.SpaceIdOrOrganisationId>;
				parentId: Option.Option<Folder.FolderId>;
			}) {
				const user = yield* CurrentUser;

				if (data.public === true)
					yield* requireOwnerPro(
						Organisation.OrganisationId.make(user.activeOrganizationId),
					);

				if (Option.isSome(data.spaceId)) {
					yield* policy.canCreateIn(data.spaceId.value);
				}

				if (Option.isSome(data.parentId)) {
					const parentId = data.parentId.value;

					const parent = yield* repo
						.getById(parentId, {
							organizationId: Organisation.OrganisationId.make(
								user.activeOrganizationId,
							),
						})
						.pipe(
							Policy.withPolicy(policy.canEdit(parentId)),
							Effect.flatMap(
								Effect.catchTag("NoSuchElementException", () =>
									Effect.fail(new Folder.NotFoundError()),
								),
							),
						);
					if (parent.spaceId !== Option.getOrNull(data.spaceId))
						return yield* new Folder.NotFoundError();
				}

				yield* repo.create({
					name: data.name,
					color: data.color,
					organizationId: Organisation.OrganisationId.make(
						user.activeOrganizationId,
					),
					createdById: User.UserId.make(user.id),
					public: data.public ?? false,
					spaceId: data.spaceId,
					parentId: data.parentId,
				});
			}),

			/**
			 * Deletes a folder and all its subfolders. Videos inside the folders will be
			 * relocated to the root of the collection (space or My Caps) they're in
			 */
			delete: Effect.fn("Folders.delete")(function* (id: Folder.FolderId) {
				const [folder] = yield* db
					.use((db) =>
						db.select().from(Db.folders).where(Dz.eq(Db.folders.id, id)),
					)
					.pipe(Policy.withPolicy(policy.canEdit(id)));

				if (!folder) return yield* new Folder.NotFoundError();

				const user = yield* CurrentUser;
				yield* repo.delete(folder.id, user.id);
			}),

			update: Effect.fn("Folders.update")(function* (
				data: Folder.FolderUpdate,
			) {
				const folder = yield* (yield* repo
					.getById(data.id)
					.pipe(Policy.withPolicy(policy.canEdit(data.id)))).pipe(
					Effect.catchTag("NoSuchElementException", () =>
						Effect.fail(new Folder.NotFoundError()),
					),
				);

				// Drizzle throws on an all-undefined .set(); a payload with only an
				// id is a no-op, not an error.
				if (
					data.name === undefined &&
					data.color === undefined &&
					data.public === undefined &&
					data.publicPage === undefined &&
					data.parentId === undefined
				)
					return;

				// Publishing, or customizing the public page, is Pro-gated on the
				// org owner. Un-publishing (public: false) is always allowed.
				if (data.public === true || data.publicPage !== undefined)
					yield* requireOwnerPro(
						Organisation.OrganisationId.make(folder.organizationId),
					);

				// If parentId is provided and not null, verify it exists and belongs to the same organization
				if (data.parentId && Option.isSome(data.parentId)) {
					const parentId = data.parentId.value;
					// Check that we're not creating an immediate circular reference
					if (parentId === data.id)
						return yield* new Folder.RecursiveDefinitionError();

					const parentFolder = yield* repo
						.getById(parentId, {
							organizationId: Organisation.OrganisationId.make(
								folder.organizationId,
							),
						})
						.pipe(
							Policy.withPolicy(policy.canEdit(parentId)),
							Effect.flatMap(
								Effect.catchTag("NoSuchElementException", () =>
									Effect.fail(new Folder.ParentNotFoundError()),
								),
							),
						);
					if (parentFolder.spaceId !== folder.spaceId)
						return yield* new Folder.ParentNotFoundError();

					// Check for circular references in the folder hierarchy
					let currentParentId = parentFolder.parentId;
					const visitedParents = new Set<string>([data.id, parentId]);
					while (currentParentId) {
						if (visitedParents.has(currentParentId))
							return yield* new Folder.RecursiveDefinitionError();
						visitedParents.add(currentParentId);

						const parentId = currentParentId;
						const nextParent = yield* repo.getById(parentId, {
							organizationId: Organisation.OrganisationId.make(
								folder.organizationId,
							),
						});

						if (Option.isNone(nextParent)) break;
						currentParentId = nextParent.value.parentId;
					}
				}

				const user = yield* CurrentUser;
				yield* repo.update(data.id, user.id, {
					name: data.name,
					color: data.color,
					public: data.public,
					publicPage: data.publicPage,
					parentId: data.parentId ? Option.getOrNull(data.parentId) : undefined,
				});
			}),
		};
	}),
	dependencies: [FoldersPolicy.Default, FoldersRepo.Default, Database.Default],
}) {}
