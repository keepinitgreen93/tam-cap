import type { CloudflareDatabase } from "@cap/database/cloudflare";
import {
	requireActiveOrganization,
	requireOrganizationMember,
} from "@cap/database/cloudflare/access";
import { type AtomicSnapshot, atomic } from "@cap/database/cloudflare/atomic";
import * as Db from "@cap/database/cloudflare/schema";
import type { Storage } from "@cap/web-domain";
import * as Dz from "drizzle-orm";

export const activeIntegration = Dz.sql`(${Db.storageIntegrations.organizationId} is null or exists (select 1 from ${Db.organizations} where ${Db.organizations.id} = ${Db.storageIntegrations.organizationId} and ${Db.organizations.tombstoneAt} is null))`;
export const activeStorageObject = Dz.sql`exists (select 1 from ${Db.storageIntegrations} where ${Db.storageIntegrations.id} = ${Db.storageObjects.integrationId} and ${activeIntegration}) and (${Db.storageObjects.videoId} is null or exists (select 1 from ${Db.videos} inner join ${Db.organizations} on ${Db.organizations.id} = ${Db.videos.orgId} where (${Db.videos.id} = ${Db.storageObjects.videoId} or (${Db.videos.id} = json_extract(${Db.storageObjects.metadata}, '$.copySourceVideoId') and not exists (select 1 from videos target where target.id = ${Db.storageObjects.videoId}))) and ${Db.organizations.tombstoneAt} is null))`;

export const writableStorageObject = Dz.sql`${activeStorageObject} and exists (select 1 from ${Db.storageIntegrations} where ${Db.storageIntegrations.id} = ${Db.storageObjects.integrationId} and ${Db.storageIntegrations.ownerId} = ${Db.storageObjects.ownerId} and ${Db.storageIntegrations.status} = 'active') and (${Db.storageObjects.videoId} is null or exists (select 1 from ${Db.videos} inner join ${Db.organizations} on ${Db.organizations.id} = ${Db.videos.orgId} where (${Db.videos.id} = ${Db.storageObjects.videoId} or (${Db.videos.id} = json_extract(${Db.storageObjects.metadata}, '$.copySourceVideoId') and not exists (select 1 from videos target where target.id = ${Db.storageObjects.videoId}))) and ${Db.videos.storageIntegrationId} = ${Db.storageObjects.integrationId} and (${Db.organizations.ownerId} = ${Db.videos.ownerId} or exists (select 1 from ${Db.organizationMembers} where ${Db.organizationMembers.organizationId} = ${Db.videos.orgId} and ${Db.organizationMembers.userId} = ${Db.videos.ownerId})) and not exists (select 1 from ${Db.videoProcessingJobs} where ${Db.videoProcessingJobs.videoId} = ${Db.videos.id} and ${Db.videoProcessingJobs.errorCode} = 'video-deleting')))`;

export async function requireStorageIntegration(
	snapshot: AtomicSnapshot,
	id: Storage.StorageIntegrationId,
) {
	const [integration] = await snapshot.read((reader) =>
		reader
			.select()
			.from(Db.storageIntegrations)
			.where(Dz.eq(Db.storageIntegrations.id, id))
			.limit(1),
	);
	if (!integration || integration.status !== "active")
		throw new Error("Storage integration is unavailable");
	if (integration.organizationId)
		await requireActiveOrganization(snapshot, integration.organizationId);
	return integration;
}

export async function requireStorageObjectWrite(
	snapshot: AtomicSnapshot,
	value: Pick<
		typeof Db.storageObjects.$inferInsert,
		"integrationId" | "ownerId" | "videoId" | "metadata"
	>,
) {
	const integration = await requireStorageIntegration(
		snapshot,
		value.integrationId,
	);
	if (integration.ownerId !== value.ownerId)
		throw new Error("Storage integration ownership changed");
	if (value.videoId) {
		const videoId = value.videoId;
		let [video] = await snapshot.read((reader) =>
			reader
				.select()
				.from(Db.videos)
				.where(Dz.eq(Db.videos.id, videoId))
				.limit(1),
		);
		if (!video && value.metadata?.copySourceVideoId) {
			const sourceId = value.metadata.copySourceVideoId;
			[video] = await snapshot.read((reader) =>
				reader
					.select()
					.from(Db.videos)
					.where(Dz.eq(Db.videos.id, sourceId))
					.limit(1),
			);
		}
		if (
			!video ||
			video.storageIntegrationId !== integration.id ||
			(integration.organizationId
				? video.orgId !== integration.organizationId
				: video.ownerId !== integration.ownerId)
		)
			throw new Error("Recording storage ownership changed");
		await requireOrganizationMember(snapshot, video.orgId, video.ownerId);
		const [job] = await snapshot.read((reader) =>
			reader
				.select({ errorCode: Db.videoProcessingJobs.errorCode })
				.from(Db.videoProcessingJobs)
				.where(Dz.eq(Db.videoProcessingJobs.videoId, video.id)),
		);
		if (job?.errorCode === "video-deleting")
			throw new Error("Recording is being deleted");
	}
}

export async function writeStorageObject(
	database: CloudflareDatabase,
	value: typeof Db.storageObjects.$inferInsert,
	options: { reserve?: boolean; preserveMetadata?: boolean } = {},
) {
	if (
		value.contentLength != null &&
		(!Number.isSafeInteger(value.contentLength) || value.contentLength < 0)
	)
		throw new Error("Invalid storage object size");
	return atomic(database, async (snapshot) => {
		await requireStorageObjectWrite(snapshot, value);
		const [existing] = await snapshot.read((reader) =>
			reader
				.select()
				.from(Db.storageObjects)
				.where(
					Dz.and(
						Dz.eq(Db.storageObjects.integrationId, value.integrationId),
						Dz.eq(Db.storageObjects.objectKeyHash, value.objectKeyHash),
					),
				)
				.limit(1),
		);
		if (
			existing &&
			(existing.objectKey !== value.objectKey ||
				existing.ownerId !== value.ownerId ||
				existing.videoId !== (value.videoId ?? null))
		)
			throw new Error(
				"Storage object reservation belongs to another recording",
			);
		if (existing && options.reserve)
			return { statements: [], result: undefined };
		const statement = existing
			? database
					.update(Db.storageObjects)
					.set({
						providerObjectId: value.providerObjectId,
						uploadSessionUrl: value.uploadSessionUrl,
						uploadStatus: value.uploadStatus,
						contentType: value.contentType,
						contentLength: value.contentLength,
						metadata: options.preserveMetadata
							? existing.metadata
							: value.metadata,
						updatedAt: value.updatedAt,
					})
					.where(Dz.eq(Db.storageObjects.id, existing.id))
			: database.insert(Db.storageObjects).values(value);
		return { statements: [statement], result: undefined };
	});
}
