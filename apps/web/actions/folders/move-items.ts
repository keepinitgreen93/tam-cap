"use server";

import { getCurrentUser } from "@cap/database/auth/session";
import { requireOrganizationMember } from "@cap/database/cloudflare/access";
import { db } from "@cap/database/cloudflare/application";
import {
	type AtomicSnapshot,
	type AtomicStatement,
	atomic,
} from "@cap/database/cloudflare/atomic";
import {
	folders,
	sharedVideos,
	spaceMembers,
	spaces,
	spaceVideos,
	videos,
} from "@cap/database/cloudflare/schema";
import { nanoId } from "@cap/database/helpers";
import { activeFolder } from "@cap/web-backend/src/Folders/persistence";
import { writableVideo } from "@cap/web-backend/src/Videos/persistence";
import type { Folder, Organisation, Video } from "@cap/web-domain";
import { and, asc, eq, isNull, or } from "drizzle-orm";
import { revalidatePath } from "next/cache";
import {
	requireOrganizationAccess,
	requireOrganizationSettingsManager,
} from "@/actions/organization/authorization";
import { requireSpaceManager } from "@/actions/organization/space-authorization";
import {
	MAX_MOVE_ITEMS,
	type MoveDestinationGroup,
	type MoveFolderDestination,
	type MoveLocation,
} from "@/lib/move-items";
import { canManageOrganizationSettings } from "@/lib/permissions/roles";
import {
	idsIn,
	requireShareDestination,
	type ShareDestination,
	shareInsert,
} from "@/lib/sharing-persistence";

function requireValidLocation(location: MoveLocation) {
	if (
		!location ||
		(location.type !== "personal" &&
			location.type !== "organization" &&
			location.type !== "space")
	) {
		throw new Error("Invalid move location");
	}

	if (location.type === "space" && !location.spaceId) {
		throw new Error("A space is required");
	}
}

async function requireMoveAccess(
	user: NonNullable<Awaited<ReturnType<typeof getCurrentUser>>>,
	location: MoveLocation,
) {
	requireValidLocation(location);

	if (location.type === "personal") return;

	if (location.type === "organization") {
		await requireOrganizationSettingsManager(
			user.id,
			user.activeOrganizationId,
		);
		return;
	}

	const access = await requireSpaceManager(user.id, location.spaceId);
	if (access.organizationId !== user.activeOrganizationId) {
		throw new Error("Space not found");
	}
}

function getFolderScope(
	user: NonNullable<Awaited<ReturnType<typeof getCurrentUser>>>,
	location: MoveLocation,
	organizationId: Organisation.OrganisationId = user.activeOrganizationId,
) {
	if (location.type === "personal") {
		return and(
			activeFolder,
			eq(folders.organizationId, organizationId),
			eq(folders.createdById, user.id),
			isNull(folders.spaceId),
		);
	}

	return and(
		activeFolder,
		eq(folders.organizationId, organizationId),
		eq(
			folders.spaceId,
			location.type === "organization" ? organizationId : location.spaceId,
		),
	);
}

function normalizeVideoIds(videoIds: Video.VideoId[]) {
	const ids = [...new Set(videoIds)];
	if (ids.length === 0) throw new Error("Select at least one Cap to move");
	if (ids.length > MAX_MOVE_ITEMS) {
		throw new Error(`You can move up to ${MAX_MOVE_ITEMS} Caps at once`);
	}
	return ids;
}

function revalidateMoveLocation(location: MoveLocation) {
	revalidatePath("/dashboard/caps");
	revalidatePath("/dashboard/folder/[id]", "page");

	if (location.type !== "personal") {
		revalidatePath("/dashboard/spaces/[spaceId]", "page");
		revalidatePath("/dashboard/spaces/[spaceId]/folder/[folderId]", "page");
	}
}

export async function getMoveFolderDestinations(
	location: MoveLocation,
): Promise<MoveFolderDestination[]> {
	const user = await getCurrentUser();
	if (!user?.activeOrganizationId) throw new Error("Unauthorized");

	await requireMoveAccess(user, location);

	return db()
		.select({ id: folders.id, name: folders.name, parentId: folders.parentId })
		.from(folders)
		.where(getFolderScope(user, location))
		.orderBy(asc(folders.name));
}

export async function getOwnedVideoMoveDestinations(
	requestedOrganizationId?: Organisation.OrganisationId,
): Promise<MoveDestinationGroup[]> {
	const user = await getCurrentUser();
	const organizationId = requestedOrganizationId ?? user?.activeOrganizationId;
	if (!user || !organizationId) throw new Error("Unauthorized");
	const access = await requireOrganizationAccess(user.id, organizationId);
	const availableSpaces = await db()
		.select({ id: spaces.id, name: spaces.name })
		.from(spaces)
		.leftJoin(
			spaceMembers,
			and(
				eq(spaceMembers.spaceId, spaces.id),
				eq(spaceMembers.userId, user.id),
			),
		)
		.where(
			and(
				eq(spaces.organizationId, organizationId),
				canManageOrganizationSettings(access.role)
					? undefined
					: or(
							eq(spaces.createdById, user.id),
							eq(spaceMembers.userId, user.id),
						),
			),
		)
		.orderBy(asc(spaces.name));
	const organizationFolders = await db()
		.select({
			id: folders.id,
			name: folders.name,
			parentId: folders.parentId,
			spaceId: folders.spaceId,
		})
		.from(folders)
		.where(
			and(
				eq(folders.organizationId, organizationId),
				or(
					and(eq(folders.createdById, user.id), isNull(folders.spaceId)),
					idsIn(folders.spaceId, [
						organizationId,
						...availableSpaces.map((space) => space.id),
					]),
				),
			),
		)
		.orderBy(asc(folders.name));
	return [
		{
			location: { type: "personal" },
			name: "My Caps",
			folders: organizationFolders.filter((folder) => folder.spaceId === null),
		},
		{
			location: { type: "organization" },
			name: "All team members",
			folders: organizationFolders.filter(
				(folder) => folder.spaceId === organizationId,
			),
		},
		...availableSpaces.map(
			(space): MoveDestinationGroup => ({
				location: { type: "space", spaceId: space.id },
				name: space.name,
				folders: organizationFolders.filter(
					(folder) => folder.spaceId === space.id,
				),
			}),
		),
	];
}

async function requireMoveSnapshot(
	snapshot: AtomicSnapshot,
	user: NonNullable<Awaited<ReturnType<typeof getCurrentUser>>>,
	location: MoveLocation,
	organizationId: Organisation.OrganisationId,
	mode: "member" | "manager",
) {
	requireValidLocation(location);
	await requireOrganizationMember(snapshot, organizationId, user.id);
	if (location.type !== "personal") {
		const destination: ShareDestination =
			location.type === "organization"
				? { type: "organization", id: organizationId }
				: { type: "space", id: location.spaceId };
		const access = await requireShareDestination(
			snapshot,
			user.id,
			destination,
			mode,
		);
		if (access.organizationId !== organizationId)
			throw new Error("Space not found");
	}
}
export async function placeOwnedVideos({
	videoIds,
	folderId,
	location,
	organizationId: requestedOrganizationId,
}: {
	videoIds: Video.VideoId[];
	folderId: Folder.FolderId | null;
	location: MoveLocation;
	organizationId?: Organisation.OrganisationId;
}) {
	const user = await getCurrentUser(),
		organizationId = requestedOrganizationId ?? user?.activeOrganizationId;
	if (!user || !organizationId) throw new Error("Unauthorized");
	requireValidLocation(location);
	const ids = normalizeVideoIds(videoIds).sort(),
		newIds = new Map(ids.map((id) => [id, nanoId()])),
		now = Date.now(),
		database = db();
	await atomic(database, async (snapshot) => {
		await requireMoveSnapshot(
			snapshot,
			user,
			location,
			organizationId,
			"member",
		);
		const owned = await snapshot.read((reader) =>
			reader
				.select({ id: videos.id })
				.from(videos)
				.where(
					and(
						writableVideo,
						idsIn(videos.id, ids),
						eq(videos.ownerId, user.id),
						eq(videos.orgId, organizationId),
					),
				),
		);
		if (owned.length !== ids.length)
			throw new Error("One or more Caps cannot be moved");
		if (folderId) {
			const [folder] = await snapshot.read((reader) =>
				reader
					.select({ id: folders.id })
					.from(folders)
					.where(
						and(
							eq(folders.id, folderId),
							getFolderScope(user, location, organizationId),
						),
					)
					.limit(1),
			);
			if (!folder) throw new Error("Destination folder not found");
		}
		const statements: AtomicStatement[] = [];
		if (location.type === "personal")
			statements.push(
				database.update(videos).set({ folderId }).where(idsIn(videos.id, ids)),
			);
		else {
			const destination: ShareDestination =
				location.type === "organization"
					? { type: "organization", id: organizationId }
					: { type: "space", id: location.spaceId };
			const table =
					location.type === "organization" ? sharedVideos : spaceVideos,
				target =
					location.type === "organization"
						? eq(sharedVideos.organizationId, organizationId)
						: eq(spaceVideos.spaceId, location.spaceId);
			const existing = await snapshot.read((reader) =>
				reader
					.select({ videoId: table.videoId })
					.from(table)
					.where(and(target, idsIn(table.videoId, ids))),
			);
			const shared = new Set(existing.map((row) => row.videoId)),
				missing = ids.filter((id) => !shared.has(id));
			if (missing.length)
				statements.push(
					shareInsert(
						database,
						destination,
						missing.map((videoId) => {
							const id = newIds.get(videoId);
							if (!id) throw new Error("Sharing identifier missing");
							return { id, videoId, folderId, userId: user.id };
						}),
						now,
					),
				);
			if (existing.length)
				statements.push(
					database
						.update(table)
						.set({ folderId })
						.where(and(target, idsIn(table.videoId, ids))),
				);
		}
		return { statements, result: undefined };
	});
	revalidateMoveLocation(location);
	revalidatePath("/s/[videoId]", "page");
	return { moved: ids.length };
}
export async function moveVideos({
	videoIds,
	folderId,
	location,
}: {
	videoIds: Video.VideoId[];
	folderId: Folder.FolderId | null;
	location: MoveLocation;
}) {
	const user = await getCurrentUser();
	if (!user?.activeOrganizationId) throw new Error("Unauthorized");
	const ids = normalizeVideoIds(videoIds),
		database = db();
	await atomic(database, async (snapshot) => {
		await requireMoveSnapshot(
			snapshot,
			user,
			location,
			user.activeOrganizationId,
			"manager",
		);
		if (folderId) {
			const [folder] = await snapshot.read((reader) =>
				reader
					.select({ id: folders.id })
					.from(folders)
					.where(and(eq(folders.id, folderId), getFolderScope(user, location)))
					.limit(1),
			);
			if (!folder) throw new Error("Destination folder not found");
		}
		if (location.type === "personal") {
			const where = and(
				writableVideo,
				idsIn(videos.id, ids),
				eq(videos.ownerId, user.id),
				eq(videos.orgId, user.activeOrganizationId),
			);
			const rows = await snapshot.read((reader) =>
				reader.select({ id: videos.id }).from(videos).where(where),
			);
			if (rows.length !== ids.length)
				throw new Error("One or more Caps cannot be moved");
			return {
				statements: [database.update(videos).set({ folderId }).where(where)],
				result: undefined,
			};
		}
		const table = location.type === "organization" ? sharedVideos : spaceVideos,
			target =
				location.type === "organization"
					? eq(sharedVideos.organizationId, user.activeOrganizationId)
					: eq(spaceVideos.spaceId, location.spaceId);
		const where = and(target, idsIn(table.videoId, ids));
		const rows = await snapshot.read((reader) =>
			reader
				.selectDistinct({ id: table.videoId })
				.from(table)
				.innerJoin(videos, eq(videos.id, table.videoId))
				.where(and(where, writableVideo)),
		);
		if (rows.length !== ids.length)
			throw new Error("One or more Caps cannot be moved");
		return {
			statements: [database.update(table).set({ folderId }).where(where)],
			result: undefined,
		};
	});
	revalidateMoveLocation(location);
	return { moved: ids.length };
}
export async function moveFolder({
	folderId,
	parentId,
	location,
}: {
	folderId: Folder.FolderId;
	parentId: Folder.FolderId | null;
	location: MoveLocation;
}) {
	const user = await getCurrentUser();
	if (!user?.activeOrganizationId) throw new Error("Unauthorized");
	const database = db();
	await atomic(database, async (snapshot) => {
		await requireMoveSnapshot(
			snapshot,
			user,
			location,
			user.activeOrganizationId,
			"manager",
		);
		const scoped = await snapshot.read((reader) =>
			reader
				.select({ id: folders.id, parentId: folders.parentId })
				.from(folders)
				.where(getFolderScope(user, location)),
		);
		const byId = new Map(scoped.map((folder) => [folder.id, folder]));
		if (!byId.has(folderId)) throw new Error("Folder not found");
		if (parentId && !byId.has(parentId))
			throw new Error("Destination folder not found");
		const visited = new Set<Folder.FolderId>();
		let current = parentId;
		while (current) {
			if (current === folderId)
				throw new Error("A folder cannot be moved into itself");
			if (visited.has(current)) throw new Error("Invalid folder hierarchy");
			visited.add(current);
			current = byId.get(current)?.parentId ?? null;
		}
		return {
			statements: [
				database
					.update(folders)
					.set({ parentId })
					.where(and(eq(folders.id, folderId), getFolderScope(user, location))),
			],
			result: undefined,
		};
	});
	revalidateMoveLocation(location);
}
