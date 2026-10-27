import "server-only";

import {
	requireActiveOrganization,
	requireOrganizationMember,
} from "@cap/database/cloudflare/access";
import { db } from "@cap/database/cloudflare/application";
import { type AtomicStatement, atomic } from "@cap/database/cloudflare/atomic";
import {
	folders,
	importedVideos,
	organizations,
	sharedVideos,
	videos,
} from "@cap/database/cloudflare/schema";
import { nanoId } from "@cap/database/helpers";
import { Folder, Organisation, User, Video } from "@cap/web-domain";
import { and, eq, isNull, ne } from "drizzle-orm";
import {
	assertMigrationOperator,
	requireMigrationOperator,
} from "@/lib/loom-concierge";
import {
	getOrganizationMemberByEmail,
	isValidImportEmail,
	normalizeImportEmail,
} from "@/lib/loom-csv-import";
import { reassignLoomImport } from "@/lib/loom-import-reassign";
import { getOwnerOriginalKey } from "@/lib/loom-original-key";
import { provisionOrganizationInvitee } from "@/lib/organization-provisioning";

export type LoomBackfillItem = {
	videoId: string;
	ownerEmail?: string;
	folderId?: string;
	effectiveCreatedAt?: string;
	shareFolderId?: string;
};

export type LoomBackfillOutcome = {
	videoId: string;
	status: "updated" | "unchanged" | "skipped" | "failed";
	changes: string[];
	reason?: string;
	warning?: string;
};

type FolderRow = { id: Folder.FolderId; createdById: User.UserId };

export async function backfillLoomImport(
	organizationId: string,
	item: LoomBackfillItem,
	operatorId?: User.UserId,
): Promise<LoomBackfillOutcome> {
	const operator = operatorId ?? (await requireMigrationOperator()).id;
	const orgId = Organisation.OrganisationId.make(organizationId);
	const id = Video.VideoId.make(item.videoId);
	const changes: string[] = [];
	const result = (
		status: LoomBackfillOutcome["status"],
		extra: Partial<LoomBackfillOutcome> = {},
	): LoomBackfillOutcome => ({
		videoId: item.videoId,
		status,
		changes,
		...extra,
	});
	const [video] = await db()
		.select({
			ownerId: videos.ownerId,
			folderId: videos.folderId,
			effectiveCreatedAt: videos.effectiveCreatedAt,
			metadata: videos.metadata,
			orgOwnerId: organizations.ownerId,
		})
		.from(videos)
		.innerJoin(
			importedVideos,
			and(
				eq(importedVideos.id, videos.id),
				eq(importedVideos.orgId, videos.orgId),
				eq(importedVideos.source, "loom"),
			),
		)
		.innerJoin(organizations, eq(organizations.id, videos.orgId))
		.where(and(eq(videos.id, id), eq(videos.orgId, orgId)))
		.limit(1);
	if (!video) return result("skipped", { reason: "not a Loom import here" });

	const date = item.effectiveCreatedAt
		? new Date(item.effectiveCreatedAt)
		: undefined;
	if (date && Number.isNaN(date.getTime()))
		return result("failed", { reason: "invalid date" });

	const email =
		item.ownerEmail !== undefined
			? normalizeImportEmail(item.ownerEmail)
			: undefined;
	if (email !== undefined && !isValidImportEmail(email))
		return result("skipped", { reason: "invalid owner email" });

	const personalFolder = item.folderId
		? await findFolder(orgId, item.folderId, false)
		: undefined;
	if (item.folderId && !personalFolder)
		return result("skipped", { reason: "folder not in this workspace" });
	const sharedFolder = item.shareFolderId
		? await findFolder(orgId, item.shareFolderId, true)
		: undefined;
	if (item.shareFolderId && !sharedFolder)
		return result("skipped", {
			reason: "shared folder not in this workspace",
		});

	let ownerId = video.ownerId;
	if (email) {
		const member =
			(await getOrganizationMemberByEmail(orgId, email)) ??
			(await provisionOrganizationInvitee({
				organizationId: orgId,
				email,
				invitedByUserId: video.orgOwnerId,
				role: "member",
			}).then((provisioned) => ({ userId: provisioned.userId, email })));
		if (!member)
			return result("failed", {
				reason: "could not add the owner to the workspace",
			});
		ownerId = User.UserId.make(member.userId);
	}

	const canUseFolder = (folder: FolderRow) =>
		folder.createdById === ownerId;
	if (personalFolder && !canUseFolder(personalFolder))
		return result("skipped", {
			reason: "folder belongs to someone other than the owner",
		});
	const currentFolder = video.folderId
		? await findFolder(orgId, video.folderId, false)
		: undefined;
	const targetFolderId =
		personalFolder?.id ??
		(currentFolder && canUseFolder(currentFolder) ? currentFolder.id : null);

	let warning: string | undefined;
	if (ownerId !== video.ownerId) {
		const moved = await reassignLoomImport({
			organizationId,
			videoId: item.videoId,
			fromUserId: video.ownerId,
			toUserId: ownerId,
			operatorId: operator,
			options: { keepSharing: true, folderId: targetFolderId },
		});
		if (moved.status !== "moved")
			return result(moved.status, { reason: moved.reason });
		if (moved.cleanup === "failed")
			warning = "old owner media copies retained for safe cleanup";
		changes.push("owner");
		if (targetFolderId !== video.folderId) changes.push("folder");
	}
	const database = db();
	const shareId = nanoId();
	const applied = await atomic(database, async (snapshot) => {
		await assertMigrationOperator(snapshot, operator);
		await requireActiveOrganization(snapshot, orgId);
		await requireOrganizationMember(snapshot, orgId, ownerId);
		const [current] = await snapshot.read((reader) =>
			reader.select().from(videos).where(eq(videos.id, id)).limit(1),
		);
		const [mapping] = await snapshot.read((reader) =>
			reader
				.select()
				.from(importedVideos)
				.where(eq(importedVideos.id, id))
				.limit(1),
		);
		if (
			!current ||
			current.ownerId !== ownerId ||
			current.orgId !== orgId ||
			!mapping ||
			mapping.orgId !== orgId ||
			mapping.source !== "loom"
		)
			throw new Error("Video changed during backfill");
		const nextChanges: string[] = [];
		const statements: AtomicStatement[] = [];
		if (targetFolderId) {
			const [folder] = await snapshot.read((reader) =>
				reader
					.select()
					.from(folders)
					.where(eq(folders.id, targetFolderId))
					.limit(1),
			);
			if (
				!folder ||
				folder.organizationId !== orgId ||
				folder.spaceId !== null ||
				folder.createdById !== ownerId
			)
				throw new Error("Folder changed during backfill");
		}
		const metadata = { ...current.metadata };
		let metadataChanged = false;
		const deferredKey = metadata.loomDeferredProcessing?.rawFileKey;
		const repairedKey = getOwnerOriginalKey(deferredKey, ownerId, item.videoId);
		if (
			metadata.loomDeferredProcessing?.status === "pending" &&
			repairedKey &&
			repairedKey !== deferredKey
		) {
			metadata.loomDeferredProcessing = {
				...metadata.loomDeferredProcessing,
				rawFileKey: repairedKey,
			};
			metadataChanged = true;
			nextChanges.push("original");
		}
		if (date && current.effectiveCreatedAt?.getTime() !== date.getTime()) {
			metadata.customCreatedAt = date.toISOString();
			metadataChanged = true;
			nextChanges.push("date");
		}
		if (current.folderId !== targetFolderId) nextChanges.push("folder");
		if (metadataChanged || current.folderId !== targetFolderId)
			statements.push(
				database
					.update(videos)
					.set({
						...(metadataChanged ? { metadata } : {}),
						folderId: targetFolderId,
					})
					.where(eq(videos.id, id)),
			);
		if (sharedFolder) {
			const [folder] = await snapshot.read((reader) =>
				reader
					.select()
					.from(folders)
					.where(eq(folders.id, sharedFolder.id))
					.limit(1),
			);
			if (
				!folder ||
				folder.organizationId !== orgId ||
				folder.spaceId !== orgId
			)
				throw new Error("Shared folder changed during backfill");
			const shares = await snapshot.read((reader) =>
				reader
					.select()
					.from(sharedVideos)
					.where(
						and(
							eq(sharedVideos.videoId, id),
							eq(sharedVideos.organizationId, orgId),
						),
					),
			);
			const [keep, ...duplicates] = shares;
			if (duplicates.length && keep)
				statements.push(
					database
						.delete(sharedVideos)
						.where(
							and(
								eq(sharedVideos.videoId, id),
								eq(sharedVideos.organizationId, orgId),
								ne(sharedVideos.id, keep.id),
							),
						),
				);
			if (!keep)
				statements.push(
					database.insert(sharedVideos).values({
						id: shareId,
						videoId: id,
						organizationId: orgId,
						folderId: folder.id,
						sharedByUserId: ownerId,
					}),
				);
			else if (keep.folderId !== folder.id)
				statements.push(
					database
						.update(sharedVideos)
						.set({ folderId: folder.id })
						.where(eq(sharedVideos.id, keep.id)),
				);
			if (!keep || keep.folderId !== folder.id || duplicates.length)
				nextChanges.push("shared");
		}
		return { statements, result: nextChanges };
	});
	for (const change of applied)
		if (!changes.includes(change)) changes.push(change);

	return result(changes.length > 0 ? "updated" : "unchanged", { warning });
}

async function findFolder(
	organizationId: Organisation.OrganisationId,
	folderId: string,
	shared: boolean,
): Promise<FolderRow | undefined> {
	const [folder] = await db()
		.select({ id: folders.id, createdById: folders.createdById })
		.from(folders)
		.where(
			and(
				eq(folders.id, Folder.FolderId.make(folderId)),
				eq(folders.organizationId, organizationId),
				shared ? eq(folders.spaceId, organizationId) : isNull(folders.spaceId),
			),
		)
		.limit(1);
	return folder;
}
