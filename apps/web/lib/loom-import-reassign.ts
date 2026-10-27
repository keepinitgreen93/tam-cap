import "server-only";
import { randomUUID } from "node:crypto";
import { requireActiveOrganization } from "@cap/database/cloudflare/access";
import { db } from "@cap/database/cloudflare/application";
import { atomic } from "@cap/database/cloudflare/atomic";
import {
	importedVideos,
	organizationMembers,
	sharedVideos,
	spaceVideos,
	videos,
} from "@cap/database/cloudflare/schema";
import { Folder, Organisation, User, Video } from "@cap/web-domain";
import { and, eq, sql } from "drizzle-orm";
import {
	assertMigrationOperator,
	requireMigrationOperator,
} from "./loom-concierge";
import { LOOM_REASSIGN_CLAIM_TTL_MS } from "./loom-original-key";
import {
	loadVideoOwnershipTransfer,
	planVideoOwnershipTransfer,
	prepareVideoOwnershipTransfer,
	retainedOwnershipTransferMediaReason,
} from "./video-ownership-transfer";

export type LoomReassignOptions = {
	keepSharing?: boolean;
	folderId?: string | null;
};
export type LoomReassignOutcome =
	| {
			videoId: string;
			status: "moved";
			copiedObjects: number;
			cleanup: "done" | "failed";
			cleanupReason?: string;
	  }
	| { videoId: string; status: "skipped" | "failed"; reason: string };

export async function reassignLoomImport({
	organizationId,
	videoId,
	fromUserId,
	toUserId,
	operatorId: trustedOperatorId,
	options = {},
}: {
	organizationId: string;
	videoId: string;
	fromUserId: string;
	toUserId: string;
	operatorId?: User.UserId;
	options?: LoomReassignOptions;
}): Promise<LoomReassignOutcome> {
	const operatorId = trustedOperatorId ?? (await requireMigrationOperator()).id;
	const database = db(),
		id = Video.VideoId.make(videoId),
		orgId = Organisation.OrganisationId.make(organizationId),
		targetUserId = User.UserId.make(toUserId),
		token = randomUUID(),
		now = new Date();
	const claimed = await atomic(database, async (snapshot) => {
		await assertMigrationOperator(snapshot, operatorId);
		const organization = await requireActiveOrganization(snapshot, orgId);
		const [imported] = await snapshot.read((reader) =>
			reader
				.select({ id: importedVideos.id })
				.from(importedVideos)
				.where(
					and(
						eq(importedVideos.id, id),
						eq(importedVideos.orgId, orgId),
						eq(importedVideos.source, "loom"),
					),
				)
				.limit(1),
		);
		const skip = (reason: string) => ({
			statements: [],
			result: { state: null, reason },
		});
		if (!imported) return skip("not a Loom import here");
		const current = await loadVideoOwnershipTransfer(snapshot, id);
		if (current.video.orgId !== orgId) return skip("not a Loom import here");
		if (current.video.ownerId === targetUserId) return skip("already owned");
		if (current.video.ownerId !== fromUserId) return skip("different owner");
		if (current.video.bucket || current.video.storageIntegrationId)
			return skip("custom storage");
		if (current.upload && current.upload.phase !== "complete")
			return skip("import not finished");
		if (current.video.metadata?.loomDeferredProcessing?.status === "started")
			return skip("conversion running");
		const [member] = await snapshot.read((reader) =>
			reader
				.select({ id: organizationMembers.id })
				.from(organizationMembers)
				.where(
					and(
						eq(organizationMembers.organizationId, orgId),
						eq(organizationMembers.userId, targetUserId),
					),
				)
				.limit(1),
		);
		if (organization.ownerId !== targetUserId && !member)
			return skip("new owner not a member");
		const claim = current.video.metadata?.loomReassignClaim;
		if (
			claim &&
			(!Number.isFinite(Date.parse(claim.at)) ||
				Date.parse(claim.at) > now.getTime() - LOOM_REASSIGN_CLAIM_TTL_MS)
		)
			return skip("another move is running");
		const video = {
			...current.video,
			metadata: {
				...current.video.metadata,
				loomReassignClaim: { token, at: now.toISOString() },
			},
			updatedAt: now,
		};
		return {
			statements: [
				database
					.update(videos)
					.set({ metadata: video.metadata, updatedAt: now })
					.where(eq(videos.id, id)),
			],
			result: { state: { ...current, video }, reason: null },
		};
	});
	if (!claimed.state)
		return {
			videoId,
			status: "skipped",
			reason: claimed.reason ?? "unavailable",
		};
	try {
		const prepared = await prepareVideoOwnershipTransfer(
			claimed.state,
			targetUserId,
		);
		const folderId = options.folderId
			? Folder.FolderId.make(options.folderId)
			: null;
		const movedAt = new Date();
		try {
			await atomic(database, async (snapshot) => {
				await assertMigrationOperator(snapshot, operatorId);
				const [imported] = await snapshot.read((reader) =>
					reader
						.select({ id: importedVideos.id })
						.from(importedVideos)
						.where(
							and(
								eq(importedVideos.id, id),
								eq(importedVideos.orgId, orgId),
								eq(importedVideos.source, "loom"),
							),
						)
						.limit(1),
				);
				if (!imported)
					throw Error("Recording import scope changed during the move");
				const statements = await planVideoOwnershipTransfer(
					snapshot,
					database,
					prepared,
					{ organizationId: orgId, folderId, now: movedAt },
				);
				if (!options.keepSharing)
					statements.push(
						database
							.update(videos)
							.set({ public: false, updatedAt: movedAt })
							.where(eq(videos.id, id)),
						database.delete(sharedVideos).where(eq(sharedVideos.videoId, id)),
						database.delete(spaceVideos).where(eq(spaceVideos.videoId, id)),
					);
				return { statements, result: undefined };
			});
		} catch (error) {
			const committed = await atomic(database, async (snapshot) => {
				const [current] = await snapshot.read((reader) =>
					reader.select().from(videos).where(eq(videos.id, id)).limit(1),
				);
				return {
					statements: [],
					result: Boolean(
						current?.ownerId === targetUserId &&
							current.orgId === orgId &&
							current.folderId === folderId &&
							current.metadata?.loomReassignClaim?.token === token &&
							current.metadata?.transcriptPublication?.id ===
								prepared.targetVideo.metadata?.transcriptPublication?.id,
					),
				};
			});
			if (!committed) throw error;
		}
		return {
			videoId,
			status: "moved",
			copiedObjects: prepared.copiedObjects,
			cleanup: "failed",
			cleanupReason: retainedOwnershipTransferMediaReason,
		};
	} finally {
		await database
			.update(videos)
			.set({
				metadata: sql`json_remove(${videos.metadata},'$.loomReassignClaim')`,
				updatedAt: sql`${videos.updatedAt}`,
			})
			.where(
				and(
					eq(videos.id, id),
					sql`json_extract(${videos.metadata},'$.loomReassignClaim.token') = ${token}`,
				),
			);
	}
}
