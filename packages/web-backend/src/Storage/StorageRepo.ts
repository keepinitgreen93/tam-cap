import { createHash } from "node:crypto";
import {
	requireActiveOrganization,
	requireOrganizationMember,
} from "@cap/database/cloudflare/access";
import { atomic } from "@cap/database/cloudflare/atomic";
import * as Db from "@cap/database/cloudflare/schema";
import { decrypt, encrypt } from "@cap/database/crypto";
import { nanoId } from "@cap/database/helpers";
import {
	type Organisation,
	Storage,
	type User,
	type Video,
} from "@cap/web-domain";
import * as Dz from "drizzle-orm";
import { Effect, Option } from "effect";
import { CloudflareDatabase as Database } from "../CloudflareDatabase.ts";
import {
	activeVideo,
	requireLiveVideo,
	requireWritableVideo,
} from "../Videos/persistence.ts";
import {
	activeIntegration,
	activeStorageObject,
	requireStorageObjectWrite,
	writableStorageObject,
	writeStorageObject,
} from "./persistence.ts";

export const getObjectKeyHash = (key: string) =>
	createHash("sha256").update(key).digest("hex");

export type GoogleDriveIntegrationConfig = {
	refreshToken: string;
	folderId: string;
	folderName?: string;
	driveId?: string | null;
	driveName?: string | null;
	folderLayout?: "video" | "userVideo";
	email?: string;
	scope?: string;
};

export type GoogleDriveStorageQuota = {
	limit?: string | null;
	usage?: string | null;
	usageInDrive?: string | null;
	usageInDriveTrash?: string | null;
};

export type GoogleDriveStorageQuotaCache = GoogleDriveStorageQuota & {
	fetchedAt: string;
};

export type GoogleDriveAccessTokenCache = {
	accessToken: string;
	expiresAt: Date;
};

export type StorageObjectInput = {
	integrationId: Storage.StorageIntegrationId;
	ownerId: User.UserId;
	videoId: Video.VideoId | null;
	objectKey: string;
	providerObjectId: string;
	uploadSessionUrl?: string | null;
	uploadStatus?: "pending" | "complete" | "error";
	contentType?: string | null;
	contentLength?: number | null;
	metadata?: Storage.StorageObjectMetadata | null;
	preserveMetadata?: boolean;
};

export type StorageObjectUpdate = Omit<
	StorageObjectInput,
	"integrationId" | "ownerId" | "videoId" | "objectKey"
>;

export class StorageRepo extends Effect.Service<StorageRepo>()("StorageRepo", {
	effect: Effect.gen(function* () {
		const db = yield* Database;

		const decodeGoogleDriveAccessTokenCache = Effect.fn(
			"StorageRepo.decodeGoogleDriveAccessTokenCache",
		)(
			(input: {
				googleDriveAccessToken: string | null;
				googleDriveAccessTokenExpiresAt: Date | null;
			}) =>
				Effect.gen(function* () {
					if (
						!input.googleDriveAccessToken ||
						!input.googleDriveAccessTokenExpiresAt
					) {
						return Option.none<GoogleDriveAccessTokenCache>();
					}

					const accessToken = yield* Effect.tryPromise({
						try: () => decrypt(input.googleDriveAccessToken as string),
						catch: (cause) => new Storage.StorageError({ cause }),
					});

					return Option.some({
						accessToken,
						expiresAt: input.googleDriveAccessTokenExpiresAt,
					});
				}),
		);

		const getActiveIntegrationForUser = Effect.fn(
			"StorageRepo.getActiveIntegrationForUser",
		)((userId: User.UserId) =>
			Effect.gen(function* () {
				const [integration] = yield* db.use((db) =>
					db
						.select()
						.from(Db.storageIntegrations)
						.where(
							Dz.and(
								Dz.eq(Db.storageIntegrations.ownerId, userId),
								Dz.isNull(Db.storageIntegrations.organizationId),
								Dz.eq(Db.storageIntegrations.active, true),
								Dz.eq(Db.storageIntegrations.status, "active"),
							),
						),
				);

				return Option.fromNullable(integration);
			}),
		);

		const getActiveIntegrationForOrganization = Effect.fn(
			"StorageRepo.getActiveIntegrationForOrganization",
		)((organizationId: Organisation.OrganisationId) =>
			Effect.gen(function* () {
				const [integration] = yield* db.use((db) =>
					db
						.select()
						.from(Db.storageIntegrations)
						.where(
							Dz.and(
								Dz.eq(Db.storageIntegrations.organizationId, organizationId),
								activeIntegration,
								Dz.eq(Db.storageIntegrations.active, true),
								Dz.eq(Db.storageIntegrations.status, "active"),
							),
						),
				);

				return Option.fromNullable(integration);
			}),
		);

		const getIntegrationById = Effect.fn("StorageRepo.getIntegrationById")(
			(id: Storage.StorageIntegrationId) =>
				Effect.gen(function* () {
					const [integration] = yield* db.use((db) =>
						db
							.select()
							.from(Db.storageIntegrations)
							.where(
								Dz.and(Dz.eq(Db.storageIntegrations.id, id), activeIntegration),
							),
					);

					return Option.fromNullable(integration);
				}),
		);

		const getGoogleDriveConfig = Effect.fn("StorageRepo.getGoogleDriveConfig")(
			(integration: typeof Db.storageIntegrations.$inferSelect) =>
				Effect.tryPromise({
					try: async () =>
						JSON.parse(
							await decrypt(integration.encryptedConfig),
						) as GoogleDriveIntegrationConfig,
					catch: (cause) => new Storage.StorageError({ cause }),
				}),
		);

		const getGoogleDriveAccessTokenCache = Effect.fn(
			"StorageRepo.getGoogleDriveAccessTokenCache",
		)((integration: typeof Db.storageIntegrations.$inferSelect) =>
			decodeGoogleDriveAccessTokenCache({
				googleDriveAccessToken: integration.googleDriveAccessToken,
				googleDriveAccessTokenExpiresAt:
					integration.googleDriveAccessTokenExpiresAt,
			}),
		);

		const getGoogleDriveAccessTokenCacheById = Effect.fn(
			"StorageRepo.getGoogleDriveAccessTokenCacheById",
		)((id: Storage.StorageIntegrationId) =>
			Effect.gen(function* () {
				const [integration] = yield* db.use((db) =>
					db
						.select({
							googleDriveAccessToken:
								Db.storageIntegrations.googleDriveAccessToken,
							googleDriveAccessTokenExpiresAt:
								Db.storageIntegrations.googleDriveAccessTokenExpiresAt,
						})
						.from(Db.storageIntegrations)
						.where(
							Dz.and(Dz.eq(Db.storageIntegrations.id, id), activeIntegration),
						)
						.limit(1),
				);

				if (!integration) return Option.none<GoogleDriveAccessTokenCache>();
				return yield* decodeGoogleDriveAccessTokenCache(integration);
			}),
		);

		const claimGoogleDriveTokenRefreshLease = Effect.fn(
			"StorageRepo.claimGoogleDriveTokenRefreshLease",
		)(
			(
				id: Storage.StorageIntegrationId,
				leaseId: string,
				leaseExpiresAt: Date,
			) =>
				Effect.gen(function* () {
					const result = yield* db.use((db) =>
						db
							.update(Db.storageIntegrations)
							.set({
								googleDriveTokenRefreshLeaseId: leaseId,
								googleDriveTokenRefreshLeaseExpiresAt: leaseExpiresAt,
								updatedAt: new Date(),
							})
							.where(
								Dz.and(
									Dz.and(
										Dz.eq(Db.storageIntegrations.id, id),
										activeIntegration,
									),
									Dz.or(
										Dz.isNull(
											Db.storageIntegrations
												.googleDriveTokenRefreshLeaseExpiresAt,
										),
										Dz.lt(
											Db.storageIntegrations
												.googleDriveTokenRefreshLeaseExpiresAt,
											new Date(),
										),
									),
								),
							),
					);

					return result.meta.changes > 0;
				}),
		);

		const saveGoogleDriveAccessTokenCache = Effect.fn(
			"StorageRepo.saveGoogleDriveAccessTokenCache",
		)(
			(
				id: Storage.StorageIntegrationId,
				leaseId: string,
				cache: GoogleDriveAccessTokenCache,
			) =>
				Effect.gen(function* () {
					const googleDriveAccessToken = yield* Effect.tryPromise({
						try: () => encrypt(cache.accessToken),
						catch: (cause) => new Storage.StorageError({ cause }),
					});

					const result = yield* db.use((db) =>
						db
							.update(Db.storageIntegrations)
							.set({
								googleDriveAccessToken,
								googleDriveAccessTokenExpiresAt: cache.expiresAt,
								googleDriveTokenRefreshLeaseId: null,
								googleDriveTokenRefreshLeaseExpiresAt: null,
								updatedAt: new Date(),
							})
							.where(
								Dz.and(
									Dz.and(
										Dz.eq(Db.storageIntegrations.id, id),
										activeIntegration,
									),
									Dz.eq(
										Db.storageIntegrations.googleDriveTokenRefreshLeaseId,
										leaseId,
									),
								),
							),
					);

					return result.meta.changes > 0;
				}),
		);

		const releaseGoogleDriveTokenRefreshLease = Effect.fn(
			"StorageRepo.releaseGoogleDriveTokenRefreshLease",
		)((id: Storage.StorageIntegrationId, leaseId: string) =>
			db.use((db) =>
				db
					.update(Db.storageIntegrations)
					.set({
						googleDriveTokenRefreshLeaseId: null,
						googleDriveTokenRefreshLeaseExpiresAt: null,
						updatedAt: new Date(),
					})
					.where(
						Dz.and(
							Dz.and(Dz.eq(Db.storageIntegrations.id, id), activeIntegration),
							Dz.eq(
								Db.storageIntegrations.googleDriveTokenRefreshLeaseId,
								leaseId,
							),
						),
					),
			),
		);

		const upsertObject = Effect.fn("StorageRepo.upsertObject")(
			(input: StorageObjectInput) =>
				Effect.gen(function* () {
					const objectKeyHash = getObjectKeyHash(input.objectKey);
					const uploadSessionUrl = input.uploadSessionUrl
						? yield* Effect.tryPromise({
								try: () => encrypt(input.uploadSessionUrl as string),
								catch: (cause) => new Storage.StorageError({ cause }),
							})
						: null;

					const value = {
						id: Storage.StorageObjectId.make(nanoId()),
						integrationId: input.integrationId,
						ownerId: input.ownerId,
						videoId: input.videoId,
						objectKey: input.objectKey,
						objectKeyHash,
						providerObjectId: input.providerObjectId,
						uploadSessionUrl,
						uploadStatus: input.uploadStatus ?? "pending",
						contentType: input.contentType ?? null,
						contentLength: input.contentLength ?? null,
						metadata: input.metadata ?? null,
					};

					yield* db.use((database) =>
						writeStorageObject(
							database,
							{ ...value, updatedAt: new Date() },
							{ preserveMetadata: input.preserveMetadata },
						),
					);
				}),
		);

		const updateObjectIfCurrent = Effect.fn(
			"StorageRepo.updateObjectIfCurrent",
		)(
			(
				object: typeof Db.storageObjects.$inferSelect,
				input: StorageObjectUpdate,
			) =>
				Effect.gen(function* () {
					const uploadSessionUrl = input.uploadSessionUrl
						? yield* Effect.tryPromise({
								try: () => encrypt(input.uploadSessionUrl as string),
								catch: (cause) => new Storage.StorageError({ cause }),
							})
						: null;

					const updatedAt = new Date();
					return yield* db.use((database) =>
						atomic(database, async (snapshot) => {
							const [current] = await snapshot.read((reader) =>
								reader
									.select()
									.from(Db.storageObjects)
									.where(Dz.eq(Db.storageObjects.id, object.id))
									.limit(1),
							);
							if (
								!current ||
								current.integrationId !== object.integrationId ||
								current.ownerId !== object.ownerId ||
								current.videoId !== object.videoId ||
								current.objectKey !== object.objectKey ||
								current.providerObjectId !== object.providerObjectId ||
								current.uploadStatus !== object.uploadStatus
							)
								return { statements: [], result: false };
							await requireStorageObjectWrite(snapshot, current);
							return {
								statements: [
									database
										.update(Db.storageObjects)
										.set({
											providerObjectId: input.providerObjectId,
											uploadSessionUrl,
											uploadStatus: input.uploadStatus ?? "pending",
											contentType: input.contentType ?? null,
											contentLength: input.contentLength ?? null,
											metadata: input.preserveMetadata
												? Dz.sql`${Db.storageObjects.metadata}`
												: (input.metadata ?? null),
											updatedAt,
										})
										.where(
											Dz.and(
												Dz.eq(Db.storageObjects.id, object.id),
												activeStorageObject,
												Dz.eq(
													Db.storageObjects.integrationId,
													object.integrationId,
												),
												Dz.eq(
													Db.storageObjects.objectKeyHash,
													getObjectKeyHash(object.objectKey),
												),
												Dz.eq(Db.storageObjects.objectKey, object.objectKey),
												Dz.eq(
													Db.storageObjects.providerObjectId,
													object.providerObjectId,
												),
												Dz.eq(
													Db.storageObjects.uploadStatus,
													object.uploadStatus,
												),
											),
										),
								],
								result: true,
							};
						}),
					);
				}),
		);

		const reserveObject = Effect.fn("StorageRepo.reserveObject")(
			(input: StorageObjectInput) =>
				Effect.gen(function* () {
					const objectKeyHash = getObjectKeyHash(input.objectKey);
					const uploadSessionUrl = input.uploadSessionUrl
						? yield* Effect.tryPromise({
								try: () => encrypt(input.uploadSessionUrl as string),
								catch: (cause) => new Storage.StorageError({ cause }),
							})
						: null;

					const now = new Date();
					const value = {
						id: Storage.StorageObjectId.make(nanoId()),
						integrationId: input.integrationId,
						ownerId: input.ownerId,
						videoId: input.videoId,
						objectKey: input.objectKey,
						objectKeyHash,
						providerObjectId: input.providerObjectId,
						uploadSessionUrl,
						uploadStatus: input.uploadStatus ?? "pending",
						contentType: input.contentType ?? null,
						contentLength: input.contentLength ?? null,
						metadata: input.metadata ?? null,
						createdAt: now,
						updatedAt: now,
					} satisfies typeof Db.storageObjects.$inferInsert;
					yield* db.use((database) =>
						writeStorageObject(database, value, { reserve: true }),
					);

					const object = yield* getObjectByKey(
						input.integrationId,
						input.objectKey,
					);
					return yield* Option.match(object, {
						onNone: () =>
							Effect.fail(
								new Storage.StorageError({
									cause: new Error("Storage object reservation failed"),
								}),
							),
						onSome: Effect.succeed,
					});
				}),
		);

		const getObjectByKey = Effect.fn("StorageRepo.getObjectByKey")(
			(integrationId: Storage.StorageIntegrationId, key: string) =>
				Effect.gen(function* () {
					const [object] = yield* db.use((db) =>
						db
							.select()
							.from(Db.storageObjects)
							.where(
								Dz.and(
									Dz.eq(Db.storageObjects.integrationId, integrationId),
									activeStorageObject,
									Dz.eq(Db.storageObjects.objectKeyHash, getObjectKeyHash(key)),
									Dz.eq(Db.storageObjects.objectKey, key),
								),
							),
					);

					return Option.fromNullable(object).pipe(
						Option.filter((object) => object.objectKey === key),
					);
				}),
		);

		const getVideoForNameSync = Effect.fn("StorageRepo.getVideoForNameSync")(
			(videoId: Video.VideoId) =>
				db
					.use((db) =>
						db
							.select({
								id: Db.videos.id,
								name: Db.videos.name,
								ownerId: Db.videos.ownerId,
								storageIntegrationId: Db.videos.storageIntegrationId,
							})
							.from(Db.videos)
							.where(Dz.and(Dz.eq(Db.videos.id, videoId), activeVideo))
							.limit(1),
					)
					.pipe(Effect.map((rows) => Option.fromNullable(rows[0]))),
		);

		const updateObjectFileName = Effect.fn("StorageRepo.updateObjectFileName")(
			(object: typeof Db.storageObjects.$inferSelect, fileName: string) =>
				db
					.use((db) =>
						db
							.update(Db.storageObjects)
							.set({
								metadata: Dz.sql`JSON_SET(COALESCE(${Db.storageObjects.metadata}, JSON_OBJECT()), '$.fileName', ${fileName})`,
								updatedAt: new Date(),
							})
							.where(
								Dz.and(
									Dz.eq(Db.storageObjects.id, object.id),
									writableStorageObject,
									Dz.eq(Db.storageObjects.integrationId, object.integrationId),
									Dz.eq(
										Db.storageObjects.objectKeyHash,
										getObjectKeyHash(object.objectKey),
									),
									Dz.eq(Db.storageObjects.objectKey, object.objectKey),
									Dz.eq(
										Db.storageObjects.providerObjectId,
										object.providerObjectId,
									),
								),
							),
					)
					.pipe(Effect.map((result) => result.meta.changes > 0)),
		);

		const listObjectsByPrefix = Effect.fn("StorageRepo.listObjectsByPrefix")(
			(
				integrationId: Storage.StorageIntegrationId,
				prefix: string | undefined,
				maxKeys: number | undefined,
				continuationToken: string | undefined,
			) =>
				db.use(async (db) => {
					const pageSize = Math.min(Math.max(maxKeys ?? 1_000, 1), 1_000);

					const objects = await db
						.select()
						.from(Db.storageObjects)
						.where(
							Dz.and(
								Dz.eq(Db.storageObjects.integrationId, integrationId),
								activeStorageObject,
								prefix
									? Dz.gte(Db.storageObjects.objectKey, prefix)
									: undefined,
								prefix
									? Dz.sql`substr(${Db.storageObjects.objectKey}, 1, length(${prefix})) = ${prefix} collate binary`
									: undefined,
								continuationToken
									? Dz.gt(Db.storageObjects.objectKey, continuationToken)
									: undefined,
							),
						)
						.orderBy(Db.storageObjects.objectKey)
						.limit(pageSize + 1);
					const page = objects.slice(0, pageSize);
					return {
						objects: page,
						nextContinuationToken:
							objects.length > pageSize ? page.at(-1)?.objectKey : undefined,
					};
				}),
		);

		const markObjectComplete = Effect.fn("StorageRepo.markObjectComplete")(
			(
				integrationId: Storage.StorageIntegrationId,
				key: string,
				contentLength?: number | null,
			) =>
				db.use((db) =>
					db
						.update(Db.storageObjects)
						.set({
							uploadStatus: "complete",
							contentLength: contentLength ?? undefined,
							updatedAt: new Date(),
						})
						.where(
							Dz.and(
								Dz.eq(Db.storageObjects.integrationId, integrationId),
								writableStorageObject,
								Dz.eq(Db.storageObjects.objectKeyHash, getObjectKeyHash(key)),
								Dz.eq(Db.storageObjects.objectKey, key),
							),
						),
				),
		);

		const deleteObjectByKey = Effect.fn("StorageRepo.deleteObjectByKey")(
			(
				integrationId: Storage.StorageIntegrationId,
				key: string,
				providerObjectId?: string,
			) =>
				db.use((db) =>
					db
						.delete(Db.storageObjects)
						.where(
							Dz.and(
								Dz.eq(Db.storageObjects.integrationId, integrationId),
								activeStorageObject,
								Dz.eq(Db.storageObjects.objectKeyHash, getObjectKeyHash(key)),
								Dz.eq(Db.storageObjects.objectKey, key),
								providerObjectId
									? Dz.eq(Db.storageObjects.providerObjectId, providerObjectId)
									: undefined,
							),
						),
				),
		);

		const assertOrganizationAccess = (
			organizationId: Organisation.OrganisationId,
			userId?: User.UserId,
		) =>
			db.use((database) =>
				atomic(database, async (snapshot) => {
					if (userId)
						await requireOrganizationMember(snapshot, organizationId, userId);
					else await requireActiveOrganization(snapshot, organizationId);
					return { statements: [], result: undefined };
				}),
			);
		const assertVideoAccess = (videoId: Video.VideoId, ownerId: User.UserId) =>
			db.use((database) =>
				atomic(database, async (snapshot) => {
					await requireLiveVideo(snapshot, videoId, ownerId);
					return { statements: [], result: undefined };
				}),
			);

		const assertWritableVideo = (
			videoId: Video.VideoId,
			ownerId: User.UserId,
		) =>
			db.use((database) =>
				atomic(database, async (snapshot) => {
					await requireWritableVideo(snapshot, videoId, ownerId);
					return { statements: [], result: undefined };
				}),
			);

		return {
			assertOrganizationAccess,
			assertVideoAccess,
			assertWritableVideo,
			getActiveIntegrationForUser,
			getActiveIntegrationForOrganization,
			getIntegrationById,
			getGoogleDriveConfig,
			getGoogleDriveAccessTokenCache,
			getGoogleDriveAccessTokenCacheById,
			claimGoogleDriveTokenRefreshLease,
			saveGoogleDriveAccessTokenCache,
			releaseGoogleDriveTokenRefreshLease,
			upsertObject,
			updateObjectIfCurrent,
			reserveObject,
			getObjectByKey,
			getVideoForNameSync,
			updateObjectFileName,
			listObjectsByPrefix,
			markObjectComplete,
			deleteObjectByKey,
		};
	}),
	dependencies: [Database.Default],
}) {}
