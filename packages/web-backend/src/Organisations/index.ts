import {
	beginOrganizationDeletion,
	finishOrganizationDeletion,
} from "@cap/database/cloudflare/organization-delete";
import * as Db from "@cap/database/cloudflare/schema";
import { CurrentUser, Organisation, Policy } from "@cap/web-domain";
import * as Dz from "drizzle-orm";
import { Effect, Array as EffectArray, Option } from "effect";
import { CloudflareDatabase as Database } from "../CloudflareDatabase";
import { ImageUploads } from "../ImageUploads";
import { S3Buckets } from "../S3Buckets";
import { Tinybird } from "../Tinybird";
import { OrganisationsPolicy } from "./OrganisationsPolicy";

const analyticsDatasources = [
	"analytics_events",
	"analytics_pages_mv",
	"analytics_sessions_mv",
] as const;
const s3DeleteBatchSize = 1000;

const escapeTinybirdLiteral = (value: string) =>
	value.replace(/\\/g, "\\\\").replace(/'/g, "''");

const tenantDeleteCondition = (tenantIds: ReadonlyArray<string>) => {
	const uniqueTenantIds = [...new Set(tenantIds.filter(Boolean))];
	return `tenant_id IN (${uniqueTenantIds
		.map((tenantId) => `'${escapeTinybirdLiteral(tenantId)}'`)
		.join(", ")})`;
};

export class Organisations extends Effect.Service<Organisations>()(
	"Organisations",
	{
		effect: Effect.gen(function* () {
			const db = yield* Database;
			const policy = yield* OrganisationsPolicy;
			const imageUploads = yield* ImageUploads;
			const s3Buckets = yield* S3Buckets;
			const tinybird = yield* Tinybird;

			const update = Effect.fn("Organisations.update")(function* (
				payload: Organisation.OrganisationUpdate,
			) {
				const organisation = yield* db
					.use((db) =>
						db
							.select()
							.from(Db.organizations)
							.where(Dz.eq(Db.organizations.id, payload.id)),
					)
					.pipe(
						Effect.flatMap(EffectArray.get(0)),
						Effect.catchTag("NoSuchElementException", () =>
							Effect.fail(new Organisation.NotFoundError()),
						),
						Policy.withPolicy(policy.isAdminOrOwner(payload.id)),
					);

				if (payload.image) {
					yield* imageUploads.applyUpdate({
						payload: payload.image,
						existing: Option.fromNullable(organisation.iconUrl),
						keyPrefix: `organizations/${organisation.id}`,
						update: (db, urlOrKey) =>
							db
								.update(Db.organizations)
								.set({ iconUrl: urlOrKey })
								.where(Dz.eq(Db.organizations.id, organisation.id)),
					});
				}
			});

			const softDelete = Effect.fn("Organisations.softDelete")(function* (
				id: Organisation.OrganisationId,
			) {
				const user = yield* CurrentUser;

				yield* Policy.withPolicy(policy.isOwner(id))(Effect.void);

				const organisation = yield* db
					.use((db) =>
						db
							.select({
								id: Db.organizations.id,
								ownerId: Db.organizations.ownerId,
							})
							.from(Db.organizations)
							.where(Dz.eq(Db.organizations.id, id)),
					)
					.pipe(
						Effect.flatMap(EffectArray.get(0)),
						Effect.catchTag("NoSuchElementException", () =>
							Effect.fail(new Organisation.NotFoundError()),
						),
					);

				yield* db.use((database) =>
					beginOrganizationDeletion(database, id, user.id),
				);

				const videos = yield* db.use((db) =>
					db
						.select({
							id: Db.videos.id,
							ownerId: Db.videos.ownerId,
							bucket: Db.videos.bucket,
							storageIntegrationId: Db.videos.storageIntegrationId,
						})
						.from(Db.videos)
						.where(Dz.eq(Db.videos.orgId, id)),
				);
				const capManagedVideos = videos.filter(
					(video) => !video.bucket && !video.storageIntegrationId,
				);

				const [defaultBucket] = yield* s3Buckets.getBucketAccess(Option.none());

				const deleteS3Prefix = (prefix: string) =>
					Effect.gen(function* () {
						let continuationToken: string | undefined;
						do {
							const listedObjects = yield* defaultBucket.listObjects({
								prefix,
								continuationToken,
							});
							const objects =
								listedObjects.Contents?.filter(
									(object): object is { Key: string } => Boolean(object.Key),
								) ?? [];

							for (
								let index = 0;
								index < objects.length;
								index += s3DeleteBatchSize
							) {
								yield* defaultBucket.deleteObjects(
									objects.slice(index, index + s3DeleteBatchSize),
								);
							}

							continuationToken = listedObjects.IsTruncated
								? listedObjects.NextContinuationToken
								: undefined;
						} while (continuationToken);
					});

				yield* Effect.forEach(
					capManagedVideos,
					(video) => deleteS3Prefix(`${video.ownerId}/${video.id}/`),
					{ concurrency: 3 },
				);
				yield* deleteS3Prefix(`organizations/${id}/`);

				const deleteCondition = tenantDeleteCondition([
					id,
					organisation.ownerId,
				]);
				yield* Effect.forEach(
					analyticsDatasources,
					(datasource) => tinybird.deleteData(datasource, deleteCondition),
					{ concurrency: 1 },
				);

				yield* db.use((database) =>
					finishOrganizationDeletion(database, id, user.id),
				);
			});
			return { update, softDelete };
		}),
		dependencies: [
			ImageUploads.Default,
			S3Buckets.Default,
			Tinybird.Default,
			Database.Default,
			OrganisationsPolicy.Default,
		],
	},
) {}
