import { randomUUID } from "node:crypto";
import type { Organisation, User } from "@cap/web-domain";
import {
	and,
	asc,
	eq,
	inArray,
	isNotNull,
	isNull,
	ne,
	or,
	sql,
} from "drizzle-orm";
import { atomic } from "./atomic.ts";
import type { CloudflareDatabase } from "./index.ts";
import { releaseOrganizationProSeatsStatement } from "./pro-seat.ts";
import * as tables from "./schema.ts";

export async function beginOrganizationDeletion(
	database: CloudflareDatabase,
	id: Organisation.OrganisationId,
	ownerId: User.UserId,
) {
	const now = new Date();
	const generation = randomUUID();
	await atomic(database, async (snapshot) => {
		const [organization] = await snapshot.read((reader) =>
			reader
				.select()
				.from(tables.organizations)
				.where(
					and(
						eq(tables.organizations.id, id),
						eq(tables.organizations.ownerId, ownerId),
					),
				)
				.limit(1),
		);
		if (!organization)
			throw new Error("Organization owner changed before deletion");
		const videos = database
			.select({ id: tables.videos.id })
			.from(tables.videos)
			.where(eq(tables.videos.orgId, id));
		return {
			statements: [
				database
					.update(tables.organizations)
					.set({ tombstoneAt: organization.tombstoneAt ?? now })
					.where(eq(tables.organizations.id, id)),
				database
					.update(tables.videoProcessingJobs)
					.set({
						generation,
						state: "source-blocked",
						attemptId: null,
						leaseExpiresAt: null,
						workflowRunId: null,
						remoteJobId: null,
						errorCode: "video-deleting",
						errorMessage: "Organization deletion is in progress.",
						updatedAt: now,
					})
					.where(inArray(tables.videoProcessingJobs.videoId, videos)),
			],
			result: undefined,
		};
	});
}

export async function finishOrganizationDeletion(
	database: CloudflareDatabase,
	id: Organisation.OrganisationId,
	ownerId: User.UserId,
) {
	await atomic(database, async (snapshot) => {
		const [organization] = await snapshot.read((reader) =>
			reader
				.select()
				.from(tables.organizations)
				.where(
					and(
						eq(tables.organizations.id, id),
						eq(tables.organizations.ownerId, ownerId),
						isNotNull(tables.organizations.tombstoneAt),
					),
				)
				.limit(1),
		);
		if (!organization) throw new Error("Organization deletion fence changed");
		const videoIds = database
			.select({ id: tables.videos.id })
			.from(tables.videos)
			.where(eq(tables.videos.orgId, id));
		const spaceIds = database
			.select({ id: tables.spaces.id })
			.from(tables.spaces)
			.where(eq(tables.spaces.organizationId, id));
		const integrationIds = database
			.select({ id: tables.storageIntegrations.id })
			.from(tables.storageIntegrations)
			.where(eq(tables.storageIntegrations.organizationId, id));
		const memberIds = database
			.select({ id: tables.organizationMembers.userId })
			.from(tables.organizationMembers)
			.where(eq(tables.organizationMembers.organizationId, id));
		const fallback = database
			.select({ id: tables.organizations.id })
			.from(tables.organizations)
			.leftJoin(
				tables.organizationMembers,
				and(
					eq(
						tables.organizationMembers.organizationId,
						tables.organizations.id,
					),
					eq(tables.organizationMembers.userId, tables.users.id),
				),
			)
			.where(
				and(
					ne(tables.organizations.id, id),
					isNull(tables.organizations.tombstoneAt),
					or(
						eq(tables.organizations.ownerId, tables.users.id),
						eq(tables.organizationMembers.userId, tables.users.id),
					),
				),
			)
			.orderBy(asc(tables.organizations.createdAt))
			.limit(1);
		return {
			statements: [
				releaseOrganizationProSeatsStatement(database, id),
				database
					.update(tables.users)
					.set({
						activeOrganizationId: sql`coalesce(${fallback}, '')`,
						defaultOrgId: sql`coalesce(${fallback}, '')`,
					})
					.where(
						and(
							or(
								eq(tables.users.id, ownerId),
								inArray(tables.users.id, memberIds),
							),
							or(
								eq(tables.users.activeOrganizationId, id),
								eq(tables.users.defaultOrgId, id),
							),
						),
					),
				database
					.delete(tables.comments)
					.where(inArray(tables.comments.videoId, videoIds)),
				database
					.delete(tables.notifications)
					.where(
						or(
							eq(tables.notifications.orgId, id),
							inArray(tables.notifications.videoId, videoIds),
						),
					),
				database
					.delete(tables.videoUploads)
					.where(inArray(tables.videoUploads.videoId, videoIds)),
				database
					.delete(tables.videoProcessingJobs)
					.where(inArray(tables.videoProcessingJobs.videoId, videoIds)),
				database
					.delete(tables.importedVideos)
					.where(
						or(
							eq(tables.importedVideos.orgId, id),
							inArray(tables.importedVideos.id, videoIds),
						),
					),
				database
					.delete(tables.storageObjects)
					.where(
						or(
							inArray(tables.storageObjects.videoId, videoIds),
							inArray(tables.storageObjects.integrationId, integrationIds),
						),
					),
				database
					.delete(tables.sharedVideos)
					.where(
						or(
							eq(tables.sharedVideos.organizationId, id),
							inArray(tables.sharedVideos.videoId, videoIds),
						),
					),
				database
					.delete(tables.spaceVideos)
					.where(
						or(
							inArray(tables.spaceVideos.videoId, videoIds),
							inArray(tables.spaceVideos.spaceId, spaceIds),
						),
					),
				database
					.delete(tables.spaceMembers)
					.where(inArray(tables.spaceMembers.spaceId, spaceIds)),
				database
					.delete(tables.folders)
					.where(eq(tables.folders.organizationId, id)),
				database.delete(tables.videos).where(eq(tables.videos.orgId, id)),
				database
					.delete(tables.spaces)
					.where(eq(tables.spaces.organizationId, id)),
				database
					.delete(tables.organizationMembers)
					.where(eq(tables.organizationMembers.organizationId, id)),
				database
					.delete(tables.organizationInvites)
					.where(eq(tables.organizationInvites.organizationId, id)),
				database
					.delete(tables.integrationInstallations)
					.where(eq(tables.integrationInstallations.organizationId, id)),
				database
					.delete(tables.storageIntegrations)
					.where(eq(tables.storageIntegrations.organizationId, id)),
				database
					.delete(tables.s3Buckets)
					.where(eq(tables.s3Buckets.organizationId, id)),
				database
					.delete(tables.organizationSso)
					.where(eq(tables.organizationSso.organizationId, id)),
				database
					.delete(tables.organizations)
					.where(eq(tables.organizations.id, id)),
				database
					.delete(tables.sessions)
					.where(eq(tables.sessions.userId, ownerId)),
				database
					.delete(tables.authApiKeys)
					.where(eq(tables.authApiKeys.userId, ownerId)),
			],
			result: undefined,
		};
	});
}
