import { requireWorkspaceAccount } from "@cap/database/cloudflare/access";
import { type AtomicStatement, atomic } from "@cap/database/cloudflare/atomic";
import * as Db from "@cap/database/cloudflare/schema";
import { nanoId } from "@cap/database/helpers";
import { CurrentUser, Organisation } from "@cap/web-domain";
import * as Dz from "drizzle-orm";
import { Effect, Option } from "effect";
import { CloudflareDatabase as Database } from "../CloudflareDatabase.ts";
import { ImageUploads } from "../ImageUploads/index.ts";

export class UsersOnboarding extends Effect.Service<UsersOnboarding>()(
	"UsersOnboarding",
	{
		effect: Effect.gen(function* () {
			const db = yield* Database;
			const imageUploads = yield* ImageUploads;

			return {
				welcome: Effect.fn("Onboarding.welcome")(function* (data: {
					firstName: string;
					lastName?: string;
				}) {
					const currentUser = yield* CurrentUser;

					yield* db.use((database) =>
						atomic(database, async (snapshot) => ({
							statements: [],
							result: await requireWorkspaceAccount(snapshot, currentUser.id),
						})),
					);
					const [user] = yield* db.use((db) =>
						db
							.select()
							.from(Db.users)
							.where(Dz.eq(Db.users.id, currentUser.id)),
					);
					if (!user) throw new Error("User not found");

					const firstName = data.firstName.trim();
					const lastName = data.lastName?.trim() ?? "";

					yield* db.use((db) =>
						db
							.update(Db.users)
							.set({
								onboardingSteps: {
									...user.onboardingSteps,
									welcome: true,
								},
								name: firstName,
								lastName,
							})
							.where(Dz.eq(Db.users.id, currentUser.id)),
					);

					const activeOrgId = user.activeOrganizationId || user.defaultOrgId;
					if (activeOrgId && firstName.length > 0) {
						yield* db.use((db) =>
							db
								.update(Db.organizations)
								.set({ name: `${firstName}'s Organization` })
								.where(
									Dz.and(
										Dz.eq(Db.organizations.id, activeOrgId),
										Dz.eq(Db.organizations.ownerId, currentUser.id),
										Dz.isNull(Db.organizations.tombstoneAt),
										Dz.eq(Db.organizations.name, "My Organization"),
									),
								),
						);
					}
				}),

				organizationSetup: Effect.fn("Onboarding.organizationSetup")(
					function* (data: {
						organizationName: string;
						organizationIcon?: {
							data: Uint8Array;
							contentType: string;
							fileName: string;
						};
					}) {
						const currentUser = yield* CurrentUser;

						const organizationName =
							data.organizationName.trim() || data.organizationName;
						const candidateOrganizationId = Organisation.OrganisationId.make(
							nanoId(),
						);
						const candidateMemberId = nanoId();
						const { organizationId, canEditOrganization } = yield* db.use(
							(database) =>
								atomic(database, async (snapshot) => {
									await requireWorkspaceAccount(snapshot, currentUser.id);
									const [current] = await snapshot.read((reader) =>
										reader
											.select()
											.from(Db.users)
											.where(Dz.eq(Db.users.id, currentUser.id)),
									);
									if (!current) throw new Error("User not found");
									const preferredOrganizationId =
										current.activeOrganizationId || current.defaultOrgId;
									const [existingOrg] = preferredOrganizationId
										? await snapshot.read((reader) =>
												reader
													.select()
													.from(Db.organizations)
													.where(
														Dz.eq(Db.organizations.id, preferredOrganizationId),
													),
											)
										: [];
									const resolvedOrgId =
										existingOrg?.id ?? candidateOrganizationId;
									const canEditOrganization =
										!existingOrg ||
										(existingOrg.ownerId === currentUser.id &&
											existingOrg.tombstoneAt === null);
									const statements: AtomicStatement[] = [];
									if (!existingOrg)
										statements.push(
											database.insert(Db.organizations).values({
												id: resolvedOrgId,
												ownerId: currentUser.id,
												name: organizationName,
											}),
											database.insert(Db.organizationMembers).values({
												id: candidateMemberId,
												organizationId: resolvedOrgId,
												userId: currentUser.id,
												role: "owner",
											}),
										);
									else if (canEditOrganization)
										statements.push(
											database
												.update(Db.organizations)
												.set({ name: organizationName })
												.where(
													Dz.and(
														Dz.eq(Db.organizations.id, resolvedOrgId),
														Dz.eq(Db.organizations.ownerId, currentUser.id),
														Dz.isNull(Db.organizations.tombstoneAt),
													),
												),
										);
									statements.push(
										database
											.update(Db.users)
											.set({
												...(!existingOrg?.tombstoneAt
													? { activeOrganizationId: resolvedOrgId }
													: {}),
												...(canEditOrganization
													? { defaultOrgId: resolvedOrgId }
													: {}),
												onboardingSteps: {
													...current.onboardingSteps,
													organizationSetup: true,
												},
											})
											.where(Dz.eq(Db.users.id, currentUser.id)),
									);
									return {
										statements,
										result: {
											organizationId: resolvedOrgId,
											canEditOrganization,
										},
									};
								}),
						);
						const finalOrganizationId = organizationId;

						if (canEditOrganization && data.organizationIcon) {
							const [ownedOrganization] = yield* db.use((db) =>
								db
									.select({ id: Db.organizations.id })
									.from(Db.organizations)
									.where(
										Dz.and(
											Dz.eq(Db.organizations.id, finalOrganizationId),
											Dz.eq(Db.organizations.ownerId, currentUser.id),
											Dz.isNull(Db.organizations.tombstoneAt),
										),
									),
							);
							if (!ownedOrganization)
								return { organizationId: finalOrganizationId };

							const organizationIcon = data.organizationIcon;
							const uploadEffect = Effect.gen(function* () {
								const {
									data: fileData,
									contentType,
									fileName,
								} = organizationIcon;
								const allowedExt = new Map<string, string>([
									["image/png", "png"],
									["image/jpeg", "jpg"],
									["image/webp", "webp"],
									["image/svg+xml", "svg"],
								]);
								const fileExtension = allowedExt.get(contentType);
								if (!fileExtension)
									throw new Error("Unsupported icon content type");

								yield* imageUploads.applyUpdate({
									payload: Option.some({
										data: fileData,
										contentType,
										fileName,
									}),
									existing: Option.none(),
									keyPrefix: `organizations/${finalOrganizationId}`,
									update: (db, iconUrl) =>
										db
											.update(Db.organizations)
											.set({ iconUrl })
											.where(
												Dz.and(
													Dz.eq(Db.organizations.id, finalOrganizationId),
													Dz.eq(Db.organizations.ownerId, currentUser.id),
													Dz.isNull(Db.organizations.tombstoneAt),
												),
											),
								});
							}).pipe(
								Effect.catchAll((error) =>
									Effect.logError("Failed to upload organization icon", error),
								),
							);

							yield* uploadEffect;
						}

						return { organizationId: finalOrganizationId };
					},
				),

				customDomain: Effect.fn("Onboarding.customDomain")(function* () {
					const currentUser = yield* CurrentUser;

					yield* db.use((database) =>
						atomic(database, async (snapshot) => ({
							statements: [],
							result: await requireWorkspaceAccount(snapshot, currentUser.id),
						})),
					);
					const [user] = yield* db.use((db) =>
						db
							.select()
							.from(Db.users)
							.where(Dz.eq(Db.users.id, currentUser.id)),
					);
					if (!user) throw new Error("User not found");

					yield* db.use((db) =>
						db
							.update(Db.users)
							.set({
								onboardingSteps: {
									...user.onboardingSteps,
									customDomain: true,
								},
							})
							.where(Dz.eq(Db.users.id, currentUser.id)),
					);
				}),

				inviteTeam: Effect.fn("Onboarding.inviteTeam")(function* () {
					const currentUser = yield* CurrentUser;

					yield* db.use((database) =>
						atomic(database, async (snapshot) => ({
							statements: [],
							result: await requireWorkspaceAccount(snapshot, currentUser.id),
						})),
					);
					const [user] = yield* db.use((db) =>
						db
							.select()
							.from(Db.users)
							.where(Dz.eq(Db.users.id, currentUser.id)),
					);
					if (!user) throw new Error("User not found");

					yield* db.use((db) =>
						db
							.update(Db.users)
							.set({
								onboardingSteps: {
									...user.onboardingSteps,
									inviteTeam: true,
									download: true,
								},
							})
							.where(Dz.eq(Db.users.id, currentUser.id)),
					);
				}),
				skipToDashboard: Effect.fn("Onboarding.skipToDashboard")(function* () {
					const currentUser = yield* CurrentUser;
					const candidateOrgId = Organisation.OrganisationId.make(nanoId());
					const candidateMemberId = nanoId();
					yield* db.use((database) =>
						atomic(database, async (snapshot) => {
							await requireWorkspaceAccount(snapshot, currentUser.id);
							const [user] = await snapshot.read((reader) =>
								reader
									.select()
									.from(Db.users)
									.where(Dz.eq(Db.users.id, currentUser.id)),
							);
							if (!user) throw new Error("User not found");
							const placeholder = !user.onboardingSteps?.welcome;
							const organizationId =
								user.activeOrganizationId || user.defaultOrgId;
							const [existingOrg] = organizationId
								? await snapshot.read((reader) =>
										reader
											.select()
											.from(Db.organizations)
											.where(Dz.eq(Db.organizations.id, organizationId)),
									)
								: [];
							const statements: AtomicStatement[] = [
								database
									.update(Db.users)
									.set({
										name: placeholder ? "Your name" : user.name,
										onboardingSteps: {
											welcome: true,
											organizationSetup: true,
											customDomain: true,
											inviteTeam: true,
											download: true,
										},
										...(!existingOrg
											? {
													activeOrganizationId: candidateOrgId,
													defaultOrgId: candidateOrgId,
												}
											: {}),
									})
									.where(Dz.eq(Db.users.id, currentUser.id)),
							];
							if (!existingOrg)
								statements.push(
									database.insert(Db.organizations).values({
										id: candidateOrgId,
										name: placeholder
											? "Your Organization"
											: `${user.name}'s organization`,
										ownerId: currentUser.id,
									}),
									database.insert(Db.organizationMembers).values({
										id: candidateMemberId,
										organizationId: candidateOrgId,
										userId: currentUser.id,
										role: "owner",
									}),
								);
							return { statements, result: undefined };
						}),
					);
				}),
			};
		}),
		dependencies: [Database.Default, ImageUploads.Default],
	},
) {}
