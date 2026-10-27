import { normalizeEmail } from "@cap/database/auth/identity";
import * as Db from "@cap/database/cloudflare/schema";
import { nanoId } from "@cap/database/helpers";
import { type User, Video } from "@cap/web-domain";
import * as Dz from "drizzle-orm";
import { Effect, Option } from "effect";
import type { Schema } from "effect/Schema";
import { CloudflareDatabase as Database } from "../CloudflareDatabase.ts";
import {
	activeVideo,
	createVideo,
	deleteVideo,
	prepareVideoDeletion,
	type VideoCopySource,
} from "./persistence.ts";

export type CreateVideoInput = Omit<
	Schema.Type<typeof Video.Video>,
	"id" | "createdAt" | "updatedAt"
> & { password?: string; importSource?: Video.ImportSource };

export class VideosRepo extends Effect.Service<VideosRepo>()("VideosRepo", {
	effect: Effect.gen(function* () {
		const db = yield* Database;

		/**
		 * Gets a `Video` and its accompanying password if available.
		 *
		 * The password is returned separately as the `Video` class is client-safe
		 */
		const getById = (id: Video.VideoId) =>
			Effect.gen(function* () {
				const [video] = yield* db.use((db) =>
					db
						.select()
						.from(Db.videos)
						.where(Dz.and(Dz.eq(Db.videos.id, id), activeVideo)),
				);

				return Option.fromNullable(video).pipe(
					Option.map(
						(v) =>
							[
								Video.Video.decodeSync({
									...v,
									bucketId: v.bucket,
									storageIntegrationId: v.storageIntegrationId,
									createdAt: v.createdAt.toISOString(),
									updatedAt: v.updatedAt.toISOString(),
									metadata: v.metadata,
								}),
								Option.fromNullable(video?.password),
							] as const,
					),
				);
			});

		const hasViewerGrant = (id: Video.VideoId, email: string) =>
			db.use(async (database) => {
				const [grant] = await database
					.select({ id: Db.videoViewerGrants.id })
					.from(Db.videoViewerGrants)
					.where(
						Dz.and(
							Dz.eq(Db.videoViewerGrants.videoId, id),
							Dz.eq(Db.videoViewerGrants.email, normalizeEmail(email)),
							Dz.isNull(Db.videoViewerGrants.revokedAt),
							Dz.sql`exists (select 1 from ${Db.videos} where ${Db.videos.id} = ${Db.videoViewerGrants.videoId} and ${activeVideo})`,
						),
					)
					.limit(1);
				return Boolean(grant);
			});

		const prepareDelete = (id: Video.VideoId, ownerId: User.UserId) =>
			db.use((database) => prepareVideoDeletion(database, id, ownerId));

		const delete_ = (id: Video.VideoId, ownerId?: User.UserId) =>
			db.use((database) => deleteVideo(database, id, ownerId));

		const create = (
			data: CreateVideoInput,
			options?: {
				id?: Video.VideoId;
				initialUpload?: Omit<typeof Db.videoUploads.$inferInsert, "videoId">;
				initialEdit?: Omit<typeof Db.videoEdits.$inferInsert, "videoId">;
				copySource?: VideoCopySource;
			},
		) =>
			Effect.gen(function* () {
				const id = options?.id ?? Video.VideoId.make(nanoId());

				const now = new Date();
				yield* db.use((database) =>
					createVideo(
						database,
						{
							id,
							createdAt: now,
							updatedAt: now,
							ownerId: data.ownerId,
							orgId: data.orgId,
							name: data.name,
							public: data.public,
							source: data.source,
							password: data.password,
							bucket: Option.getOrNull(data.bucketId ?? Option.none()),
							storageIntegrationId: Option.getOrNull(
								data.storageIntegrationId ?? Option.none(),
							),
							metadata: Option.getOrNull(data.metadata ?? Option.none()),
							transcriptionStatus: Option.getOrNull(
								data.transcriptionStatus ?? Option.none(),
							),
							folderId: Option.getOrNull(data.folderId ?? Option.none()),
							width: Option.getOrNull(data.width ?? Option.none()),
							height: Option.getOrNull(data.height ?? Option.none()),
							duration: Option.getOrNull(data.duration ?? Option.none()),
						},
						{
							initialUpload: options?.initialUpload,
							initialEdit: options?.initialEdit,
							copySource: options?.copySource,
							importSource: data.importSource,
						},
					),
				);

				return id;
			});

		return { getById, hasViewerGrant, prepareDelete, delete: delete_, create };
	}),
	dependencies: [Database.Default],
}) {}
