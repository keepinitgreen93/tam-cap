import * as Db from "@cap/database/cloudflare/schema";
import {
	type Organisation,
	S3Bucket,
	type User,
	type Video,
} from "@cap/web-domain";
import * as Dz from "drizzle-orm";
import { Effect, Option } from "effect";

import { CloudflareDatabase as Database } from "../CloudflareDatabase.ts";

export class S3BucketsRepo extends Effect.Service<S3BucketsRepo>()(
	"S3BucketsRepo",
	{
		effect: Effect.gen(function* () {
			const db = yield* Database;
			const activeBucket = Dz.sql`(${Db.s3Buckets.organizationId} is null or exists (select 1 from ${Db.organizations} where ${Db.organizations.id} = ${Db.s3Buckets.organizationId} and ${Db.organizations.tombstoneAt} is null))`;

			const getForVideo = Effect.fn("S3BucketsRepo.getForVideo")(
				(videoId: Video.VideoId) =>
					Effect.gen(function* () {
						const [res] = yield* db.use((db) =>
							db
								.select({ bucket: Db.s3Buckets })
								.from(Db.s3Buckets)
								.leftJoin(Db.videos, Dz.eq(Db.videos.bucket, Db.s3Buckets.id))
								.where(
									Dz.and(
										Dz.eq(Db.videos.id, videoId),
										activeBucket,
										Dz.sql`exists (select 1 from ${Db.organizations} where ${Db.organizations.id} = ${Db.videos.orgId} and ${Db.organizations.tombstoneAt} is null)`,
									),
								),
						);

						return Option.fromNullable(res).pipe(
							Option.map((v) =>
								S3Bucket.decodeSync({ ...v.bucket, name: v.bucket.bucketName }),
							),
						);
					}),
			);

			const getById = Effect.fn("S3BucketsRepo.getById")(
				(id: S3Bucket.S3BucketId) =>
					Effect.gen(function* () {
						const [res] = yield* db.use((db) =>
							db
								.select({ bucket: Db.s3Buckets })
								.from(Db.s3Buckets)
								.where(Dz.and(Dz.eq(Db.s3Buckets.id, id), activeBucket)),
						);

						return Option.fromNullable(res).pipe(
							Option.map((v) =>
								S3Bucket.decodeSync({ ...v.bucket, name: v.bucket.bucketName }),
							),
						);
					}),
			);

			const getForUser = Effect.fn("S3BucketsRepo.getForUser")(
				(userId: User.UserId) =>
					Effect.gen(function* () {
						const [res] = yield* db.use((db) =>
							db
								.select({ bucket: Db.s3Buckets })
								.from(Db.s3Buckets)
								.where(
									Dz.and(
										Dz.eq(Db.s3Buckets.ownerId, userId),
										Dz.isNull(Db.s3Buckets.organizationId),
										Dz.eq(Db.s3Buckets.active, true),
									),
								)
								.orderBy(Dz.desc(Db.s3Buckets.updatedAt)),
						);

						return Option.fromNullable(res).pipe(
							Option.map((v) =>
								S3Bucket.decodeSync({ ...v.bucket, name: v.bucket.bucketName }),
							),
						);
					}),
			);

			const getForOrganization = Effect.fn("S3BucketsRepo.getForOrganization")(
				(organizationId: Organisation.OrganisationId) =>
					Effect.gen(function* () {
						const [res] = yield* db.use((db) =>
							db
								.select({ bucket: Db.s3Buckets })
								.from(Db.s3Buckets)
								.where(
									Dz.and(
										Dz.eq(Db.s3Buckets.organizationId, organizationId),
										activeBucket,
										Dz.eq(Db.s3Buckets.active, true),
									),
								)
								.orderBy(Dz.desc(Db.s3Buckets.updatedAt)),
						);

						return Option.fromNullable(res).pipe(
							Option.map((v) =>
								S3Bucket.decodeSync({ ...v.bucket, name: v.bucket.bucketName }),
							),
						);
					}),
			);

			return { getForVideo, getById, getForUser, getForOrganization };
		}),
		dependencies: [Database.Default],
	},
) {}
