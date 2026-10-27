import type { CloudflareDatabase } from "@cap/database/cloudflare";
import {
	requireOrganizationManager,
	requireOrganizationMember,
} from "@cap/database/cloudflare/access";
import {
	type AtomicSnapshot,
	type AtomicStatement,
	atomic,
} from "@cap/database/cloudflare/atomic";
import * as Db from "@cap/database/cloudflare/schema";
import { nanoId } from "@cap/database/helpers";
import { writableVideo } from "@cap/web-backend/src/Videos/persistence";
import type { Folder, Organisation, Space, User, Video } from "@cap/web-domain";
import { and, eq, sql } from "drizzle-orm";
import { inJsonArray as idsIn } from "@/utils/sql";
import {
	canManageSpace,
	getEffectiveSpaceRole,
	normalizeOrganizationRole,
} from "./permissions/roles";

export { inJsonArray as idsIn } from "@/utils/sql";
export type ShareDestination =
	| { type: "organization"; id: Organisation.OrganisationId }
	| { type: "space"; id: Space.SpaceIdOrOrganisationId };
export async function requireShareDestination(
	snapshot: AtomicSnapshot,
	userId: User.UserId,
	destination: ShareDestination,
	mode: "member" | "manager" | "visible",
	existing = false,
) {
	if (destination.type === "organization") {
		const access = await (mode === "manager"
			? requireOrganizationManager
			: requireOrganizationMember)(snapshot, destination.id, userId);
		return {
			organizationId: destination.id,
			canManage: access.role !== "member",
			space: null,
		};
	}
	const [space] = await snapshot.read((reader) =>
		reader
			.select()
			.from(Db.spaces)
			.where(eq(Db.spaces.id, destination.id))
			.limit(1),
	);
	if (!space) throw new Error("Space not found");
	const { role: organizationRole } = await requireOrganizationMember(
		snapshot,
		space.organizationId,
		userId,
	);
	const [member] = await snapshot.read((reader) =>
		reader
			.select({ role: Db.spaceMembers.role })
			.from(Db.spaceMembers)
			.where(
				and(
					eq(Db.spaceMembers.spaceId, space.id),
					eq(Db.spaceMembers.userId, userId),
				),
			)
			.limit(1),
	);
	const spaceRole = getEffectiveSpaceRole({
		userId,
		createdById: space.createdById,
		memberRole: member?.role,
	});
	const canManage = canManageSpace({
		organizationRole: normalizeOrganizationRole(organizationRole),
		spaceRole,
	});
	if (
		!canManage &&
		!(mode !== "manager" && spaceRole) &&
		!(mode === "visible" && (space.privacy === "Public" || existing))
	)
		throw new Error("Unauthorized");
	return { organizationId: space.organizationId, canManage, space };
}
type ShareEntry = {
	id: string;
	videoId: Video.VideoId;
	folderId: Folder.FolderId | null;
	userId: User.UserId;
};
export function shareInsertRows(
	database: CloudflareDatabase,
	type: ShareDestination["type"],
	entries: (ShareEntry & { targetId: string })[],
	now: number,
) {
	const json = JSON.stringify(entries);
	return type === "organization"
		? database
				.insert(Db.sharedVideos)
				.select(
					sql`select json_extract(value,'$.id'),json_extract(value,'$.videoId'),json_extract(value,'$.folderId'),json_extract(value,'$.targetId'),json_extract(value,'$.userId'),${now} from json_each(${json})`,
				)
		: database
				.insert(Db.spaceVideos)
				.select(
					sql`select json_extract(value,'$.id'),json_extract(value,'$.targetId'),json_extract(value,'$.folderId'),json_extract(value,'$.videoId'),json_extract(value,'$.userId'),${now} from json_each(${json})`,
				);
}
export function shareInsert(
	database: CloudflareDatabase,
	destination: ShareDestination,
	entries: ShareEntry[],
	now: number,
) {
	return shareInsertRows(
		database,
		destination.type,
		entries.map((entry) => ({ ...entry, targetId: destination.id })),
		now,
	);
}
export async function mutateSharedVideos(
	database: CloudflareDatabase,
	input: {
		userId: User.UserId;
		destination: ShareDestination;
		videoIds: Video.VideoId[];
		action: "add" | "remove";
		mode: "member" | "manager";
		folderId?: Folder.FolderId | null;
		removeAnyOwner?: boolean;
		clearPersonalFolders?: boolean;
	},
) {
	const ids = [...new Set(input.videoIds)],
		newIds = new Map(ids.map((id) => [id, nanoId()])),
		now = Date.now();
	return atomic(database, async (snapshot) => {
		const access = await requireShareDestination(
			snapshot,
			input.userId,
			input.destination,
			input.mode,
		);
		if (input.folderId) {
			const folderId = input.folderId;
			const [folder] = await snapshot.read((reader) =>
				reader
					.select()
					.from(Db.folders)
					.where(eq(Db.folders.id, folderId))
					.limit(1),
			);
			if (
				!folder ||
				folder.organizationId !== access.organizationId ||
				folder.spaceId !== input.destination.id
			)
				throw new Error("Folder not found");
		}
		const owned = await snapshot.read((reader) =>
			reader
				.select({ id: Db.videos.id })
				.from(Db.videos)
				.where(
					and(
						writableVideo,
						idsIn(Db.videos.id, ids),
						input.removeAnyOwner
							? undefined
							: eq(Db.videos.ownerId, input.userId),
					),
				),
		);
		const valid = owned.map((video) => video.id);
		if (!valid.length) {
			if (input.removeAnyOwner)
				return {
					statements: [],
					result: { count: 0, organizationId: access.organizationId },
				};
			throw new Error("No valid videos found");
		}
		const table =
			input.destination.type === "organization"
				? Db.sharedVideos
				: Db.spaceVideos;
		const target =
			input.destination.type === "organization"
				? eq(Db.sharedVideos.organizationId, input.destination.id)
				: eq(Db.spaceVideos.spaceId, input.destination.id);
		const existing = await snapshot.read((reader) =>
			reader
				.select({ videoId: table.videoId })
				.from(table)
				.where(and(target, idsIn(table.videoId, valid))),
		);
		const statements: AtomicStatement[] = [];
		if (input.action === "add") {
			const already = new Set(existing.map((row) => row.videoId));
			const missing = valid.filter((id) => !already.has(id));
			if (missing.length)
				statements.push(
					shareInsert(
						database,
						input.destination,
						missing.map((videoId) => ({
							id: (() => {
								const id = newIds.get(videoId);
								if (!id) throw new Error("Sharing identifier missing");
								return id;
							})(),
							videoId,
							folderId: input.folderId ?? null,
							userId: input.userId,
						})),
						now,
					),
				);
			if (existing.length)
				statements.push(
					database
						.update(table)
						.set({ folderId: input.folderId ?? null })
						.where(and(target, idsIn(table.videoId, valid))),
				);
		} else {
			statements.push(
				database.delete(table).where(and(target, idsIn(table.videoId, valid))),
			);
			if (input.clearPersonalFolders && existing.length)
				statements.push(
					database
						.update(Db.videos)
						.set({ folderId: null })
						.where(
							and(
								idsIn(
									Db.videos.id,
									existing.map((row) => row.videoId),
								),
								sql`${Db.videos.folderId} in (select ${Db.folders.id} from ${Db.folders} where ${Db.folders.organizationId} = ${access.organizationId})`,
							),
						),
				);
		}
		return {
			statements,
			result: {
				count:
					input.action === "remove" && input.removeAnyOwner
						? existing.length
						: valid.length,
				organizationId: access.organizationId,
			},
		};
	});
}
