import { randomUUID } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import type { CloudflareDatabase } from "@cap/database/cloudflare";
import {
	requireActiveOrganization,
	requireOrganizationMember,
} from "@cap/database/cloudflare/access";
import {
	type AtomicSnapshot,
	type AtomicStatement,
	atomic,
} from "@cap/database/cloudflare/atomic";
import * as Db from "@cap/database/cloudflare/schema";
import {
	type TranscriptVideo,
	transcriptMediaRevision,
} from "@cap/database/cloudflare/transcript-publication";
import type { User, Video } from "@cap/web-domain";
import * as Dz from "drizzle-orm";

export const activeVideo = Dz.sql`exists (select 1 from ${Db.organizations} where ${Db.organizations.id} = ${Db.videos.orgId} and ${Db.organizations.tombstoneAt} is null)`;

export const writableVideo = Dz.sql`${activeVideo} and exists (select 1 from ${Db.organizations} where ${Db.organizations.id} = ${Db.videos.orgId} and (${Db.organizations.ownerId} = ${Db.videos.ownerId} or exists (select 1 from ${Db.organizationMembers} where ${Db.organizationMembers.organizationId} = ${Db.videos.orgId} and ${Db.organizationMembers.userId} = ${Db.videos.ownerId}))) and not exists (select 1 from ${Db.videoProcessingJobs} where ${Db.videoProcessingJobs.videoId} = ${Db.videos.id} and ${Db.videoProcessingJobs.errorCode} = 'video-deleting')`;

export async function requireLiveVideo(
	snapshot: AtomicSnapshot,
	id: Video.VideoId,
	ownerId?: User.UserId,
) {
	const [video] = await snapshot.read((reader) =>
		reader.select().from(Db.videos).where(Dz.eq(Db.videos.id, id)).limit(1),
	);
	if (!video || (ownerId && video.ownerId !== ownerId))
		throw new Error("Video ownership changed or recording is unavailable");
	await requireActiveOrganization(snapshot, video.orgId);
	return video;
}

export async function requireOwnedVideo(
	snapshot: AtomicSnapshot,
	id: Video.VideoId,
	ownerId?: User.UserId,
) {
	const video = await requireLiveVideo(snapshot, id, ownerId);
	await requireOrganizationMember(snapshot, video.orgId, video.ownerId);
	return video;
}

export async function requireWritableVideo(
	snapshot: AtomicSnapshot,
	id: Video.VideoId,
	ownerId?: User.UserId,
) {
	const video = await requireOwnedVideo(snapshot, id, ownerId);
	const [job] = await snapshot.read((reader) =>
		reader
			.select({ errorCode: Db.videoProcessingJobs.errorCode })
			.from(Db.videoProcessingJobs)
			.where(Dz.eq(Db.videoProcessingJobs.videoId, id)),
	);
	if (job?.errorCode === "video-deleting")
		throw new Error("Recording is being deleted");
	return video;
}

export async function prepareVideoDeletion(
	database: CloudflareDatabase,
	id: Video.VideoId,
	ownerId: User.UserId,
) {
	const now = new Date();
	const retired = {
		generation: randomUUID(),
		state: "source-blocked" as const,
		attemptId: null,
		leaseExpiresAt: null,
		nextRetryAt: now,
		workflowRunId: null,
		remoteJobId: null,
		errorCode: "video-deleting",
		errorMessage: "Recording deletion is in progress.",
		updatedAt: now,
	};
	return atomic(database, async (snapshot) => {
		await requireOwnedVideo(snapshot, id, ownerId);
		return {
			statements: [
				database
					.insert(Db.videoProcessingJobs)
					.values({ videoId: id, ownerId, createdAt: now, ...retired })
					.onConflictDoUpdate({
						target: Db.videoProcessingJobs.videoId,
						set: retired,
					}),
			],
			result: undefined,
		};
	});
}

export function deleteVideoStatements(
	database: CloudflareDatabase,
	id: Video.VideoId,
): AtomicStatement[] {
	return [
		database
			.delete(Db.videoProcessingJobs)
			.where(Dz.eq(Db.videoProcessingJobs.videoId, id)),
		database.delete(Db.sharedVideos).where(Dz.eq(Db.sharedVideos.videoId, id)),
		database.delete(Db.spaceVideos).where(Dz.eq(Db.spaceVideos.videoId, id)),
		database.delete(Db.importedVideos).where(Dz.eq(Db.importedVideos.id, id)),
		database.delete(Db.videoUploads).where(Dz.eq(Db.videoUploads.videoId, id)),
		database
			.delete(Db.storageObjects)
			.where(Dz.eq(Db.storageObjects.videoId, id)),
		database.delete(Db.comments).where(Dz.eq(Db.comments.videoId, id)),
		database
			.delete(Db.notifications)
			.where(Dz.eq(Db.notifications.videoId, id)),
		database.delete(Db.videoEdits).where(Dz.eq(Db.videoEdits.videoId, id)),
		database
			.delete(Db.videoViewerGrants)
			.where(Dz.eq(Db.videoViewerGrants.videoId, id)),
		database.delete(Db.videos).where(Dz.eq(Db.videos.id, id)),
	];
}

export async function deleteVideo(
	database: CloudflareDatabase,
	id: Video.VideoId,
	ownerId?: User.UserId,
) {
	return atomic(database, async (snapshot) => {
		const [existing] = await snapshot.read((reader) =>
			reader
				.select({ id: Db.videos.id })
				.from(Db.videos)
				.where(Dz.eq(Db.videos.id, id)),
		);
		if (!existing) return { statements: [], result: undefined };
		await requireOwnedVideo(snapshot, id, ownerId);
		return {
			statements: deleteVideoStatements(database, id),
			result: undefined,
		};
	});
}

export type VideoCopySource = {
	video: TranscriptVideo;
	edit: typeof Db.videoEdits.$inferSelect | null;
};

export async function createVideo(
	database: CloudflareDatabase,
	value: typeof Db.videos.$inferInsert,
	options?: {
		initialUpload?: Omit<typeof Db.videoUploads.$inferInsert, "videoId">;
		defaultPublic?: boolean;
		initialEdit?: Omit<typeof Db.videoEdits.$inferInsert, "videoId">;
		copySource?: VideoCopySource;
		importSource?: Video.ImportSource;
	},
) {
	return atomic(database, async (snapshot) => {
		const { organization } = await requireOrganizationMember(
			snapshot,
			value.orgId,
			value.ownerId,
		);
		if (options?.copySource) {
			const expected = options.copySource;
			const current = await requireWritableVideo(
				snapshot,
				expected.video.id,
				expected.video.ownerId,
			);
			if (
				transcriptMediaRevision(current) !==
					transcriptMediaRevision(expected.video) ||
				current.metadata?.transcriptPublication?.id !==
					expected.video.metadata?.transcriptPublication?.id
			)
				throw new Error("Recording changed during duplication");
			const [edit] = await snapshot.read((reader) =>
				reader
					.select()
					.from(Db.videoEdits)
					.where(Dz.eq(Db.videoEdits.videoId, current.id))
					.limit(1),
			);
			if (
				!isDeepStrictEqual(edit?.editSpec, expected.edit?.editSpec) ||
				edit?.sourceKey !== expected.edit?.sourceKey
			)
				throw new Error("Recording edits changed during duplication");
		}
		if (value.folderId) {
			const folderId = value.folderId;
			const [folder] = await snapshot.read((reader) =>
				reader
					.select()
					.from(Db.folders)
					.where(Dz.eq(Db.folders.id, folderId))
					.limit(1),
			);
			if (
				!folder ||
				folder.organizationId !== value.orgId ||
				folder.createdById !== value.ownerId ||
				folder.spaceId !== null
			)
				throw new Error("Recording folder is unavailable");
		}
		if (value.bucket) {
			const bucketId = value.bucket;
			const [bucket] = await snapshot.read((reader) =>
				reader
					.select()
					.from(Db.s3Buckets)
					.where(Dz.eq(Db.s3Buckets.id, bucketId))
					.limit(1),
			);
			if (
				!bucket ||
				!bucket.active ||
				(bucket.organizationId
					? bucket.organizationId !== value.orgId
					: bucket.ownerId !== value.ownerId)
			)
				throw new Error("Recording bucket is unavailable");
		}
		if (value.storageIntegrationId) {
			const integrationId = value.storageIntegrationId;
			const [integration] = await snapshot.read((reader) =>
				reader
					.select()
					.from(Db.storageIntegrations)
					.where(Dz.eq(Db.storageIntegrations.id, integrationId))
					.limit(1),
			);
			if (
				!integration ||
				!integration.active ||
				integration.status !== "active" ||
				(integration.organizationId
					? integration.organizationId !== value.orgId
					: integration.ownerId !== value.ownerId)
			)
				throw new Error("Recording storage is unavailable");
		}
		const statements: AtomicStatement[] = [
			database.insert(Db.videos).values({
				...value,
				...(options?.defaultPublic === undefined
					? {}
					: {
							public:
								organization.defaultVideoVisibility === "private"
									? false
									: options.defaultPublic,
						}),
			}),
		];
		if (options?.importSource)
			statements.push(
				database.insert(Db.importedVideos).values({
					id: value.id,
					orgId: value.orgId,
					source: options.importSource.source,
					sourceId: options.importSource.id,
				}),
			);
		if (options?.initialEdit)
			statements.push(
				database
					.insert(Db.videoEdits)
					.values({ videoId: value.id, ...options.initialEdit }),
			);
		if (options?.initialUpload)
			statements.push(
				database
					.insert(Db.videoUploads)
					.values({ videoId: value.id, ...options.initialUpload }),
			);
		return { statements, result: value.id };
	});
}

export async function updateVideoUploadProgress(
	database: CloudflareDatabase,
	ownerId: User.UserId,
	input: {
		videoId: Video.VideoId;
		uploaded: number;
		total: number;
		updatedAt: Date;
	},
) {
	if (
		!Number.isSafeInteger(input.total) ||
		input.total < 0 ||
		!Number.isSafeInteger(input.uploaded) ||
		input.uploaded < 0 ||
		!Number.isFinite(input.updatedAt.getTime())
	)
		throw new Error("Invalid upload progress");
	return atomic(database, async (snapshot) => {
		await requireOwnedVideo(snapshot, input.videoId, ownerId);
		const [job] = await snapshot.read((reader) =>
			reader
				.select({ errorCode: Db.videoProcessingJobs.errorCode })
				.from(Db.videoProcessingJobs)
				.where(Dz.eq(Db.videoProcessingJobs.videoId, input.videoId)),
		);
		if (job?.errorCode === "video-deleting")
			throw new Error("Recording is being deleted");
		const value = { ...input, uploaded: Math.min(input.uploaded, input.total) };
		return {
			statements: [
				database
					.insert(Db.videoUploads)
					.values(value)
					.onConflictDoUpdate({
						target: Db.videoUploads.videoId,
						set: {
							uploaded: value.uploaded,
							total: value.total,
							updatedAt: value.updatedAt,
						},
						setWhere: Dz.lte(Db.videoUploads.updatedAt, value.updatedAt),
					}),
			],
			result: true as const,
		};
	});
}
