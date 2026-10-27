import type { CloudflareDatabase } from "@cap/database/cloudflare";
import { requireOrganizationMember } from "@cap/database/cloudflare/access";
import { type AtomicSnapshot, atomic } from "@cap/database/cloudflare/atomic";
import * as Db from "@cap/database/cloudflare/schema";
import { userIsPro } from "@cap/utils";
import type { Folder, User } from "@cap/web-domain";
import * as Dz from "drizzle-orm";

type FolderRow = typeof Db.folders.$inferSelect;
export const activeFolder = Dz.sql`exists (select 1 from ${Db.organizations} where ${Db.organizations.id} = ${Db.folders.organizationId} and ${Db.organizations.tombstoneAt} is null)`;

async function requireFolderAccess(
	snapshot: AtomicSnapshot,
	folder: Pick<FolderRow, "spaceId" | "organizationId" | "createdById">,
	userId: User.UserId,
) {
	const { organization, role } = await requireOrganizationMember(
		snapshot,
		folder.organizationId,
		userId,
	);
	if (folder.spaceId === null) {
		if (folder.createdById !== userId)
			throw new Error("Folder ownership changed");
	} else if (folder.spaceId === folder.organizationId) {
		if (role === "member") throw new Error("Organization manager is required");
	} else {
		const spaceId = folder.spaceId;
		const [space] = await snapshot.read((reader) =>
			reader
				.select()
				.from(Db.spaces)
				.where(
					Dz.and(
						Dz.eq(Db.spaces.id, spaceId),
						Dz.eq(Db.spaces.organizationId, folder.organizationId),
					),
				)
				.limit(1),
		);
		if (!space) throw new Error("Folder space is unavailable");
		if (role === "member") {
			const [member] = await snapshot.read((reader) =>
				reader
					.select()
					.from(Db.spaceMembers)
					.where(
						Dz.and(
							Dz.eq(Db.spaceMembers.spaceId, space.id),
							Dz.eq(Db.spaceMembers.userId, userId),
							Dz.eq(Db.spaceMembers.role, "admin"),
						),
					)
					.limit(1),
			);
			if (!member) throw new Error("Space manager is required");
		}
	}
	return organization;
}

async function requirePublicPlan(
	snapshot: AtomicSnapshot,
	ownerId: User.UserId,
) {
	const [owner] = await snapshot.read((reader) =>
		reader.select().from(Db.users).where(Dz.eq(Db.users.id, ownerId)).limit(1),
	);
	if (!userIsPro(owner ?? null))
		throw new Error("Upgrade to Cap Pro to create a public collection link");
}

async function requireParent(
	snapshot: AtomicSnapshot,
	folder: Pick<FolderRow, "id" | "parentId" | "spaceId" | "organizationId">,
	userId: User.UserId,
) {
	let parentId = folder.parentId;
	const visited = new Set<string>([folder.id]);
	while (parentId) {
		if (visited.has(parentId)) throw new Error("Recursive folder hierarchy");
		visited.add(parentId);
		const id = parentId;
		const [parent] = await snapshot.read((reader) =>
			reader.select().from(Db.folders).where(Dz.eq(Db.folders.id, id)).limit(1),
		);
		if (
			!parent ||
			parent.organizationId !== folder.organizationId ||
			parent.spaceId !== folder.spaceId
		)
			throw new Error("Parent folder is unavailable");
		await requireFolderAccess(snapshot, parent, userId);
		parentId = parent.parentId;
	}
}

export async function createFolder(
	database: CloudflareDatabase,
	value: typeof Db.folders.$inferInsert,
) {
	return atomic(database, async (snapshot) => {
		const folder = {
			...value,
			parentId: value.parentId ?? null,
			spaceId: value.spaceId ?? null,
		};
		const organization = await requireFolderAccess(
			snapshot,
			folder,
			value.createdById,
		);
		if (value.public) await requirePublicPlan(snapshot, organization.ownerId);
		await requireParent(snapshot, folder, value.createdById);
		return {
			statements: [database.insert(Db.folders).values(value)],
			result: value.id,
		};
	});
}

export async function updateFolder(
	database: CloudflareDatabase,
	id: Folder.FolderId,
	userId: User.UserId,
	values: Pick<Partial<FolderRow>, "name" | "color" | "public" | "parentId"> & {
		publicPage?: NonNullable<FolderRow["settings"]>["publicPage"];
	},
) {
	const now = new Date();
	return atomic(database, async (snapshot) => {
		const [folder] = await snapshot.read((reader) =>
			reader.select().from(Db.folders).where(Dz.eq(Db.folders.id, id)).limit(1),
		);
		if (!folder) throw new Error("Folder not found");
		const organization = await requireFolderAccess(snapshot, folder, userId);
		if (values.public === true || values.publicPage !== undefined)
			await requirePublicPlan(snapshot, organization.ownerId);
		await requireParent(
			snapshot,
			{
				...folder,
				parentId:
					values.parentId === undefined ? folder.parentId : values.parentId,
			},
			userId,
		);
		if (Object.values(values).every((value) => value === undefined))
			return { statements: [], result: undefined };
		return {
			statements: [
				database
					.update(Db.folders)
					.set({
						name: values.name,
						color: values.color,
						public: values.public,
						parentId: values.parentId,
						updatedAt: now,
						settings:
							values.publicPage === undefined
								? undefined
								: Dz.sql`json_patch(coalesce(${Db.folders.settings}, '{}'), ${JSON.stringify({ publicPage: values.publicPage })})`,
					})
					.where(Dz.eq(Db.folders.id, id)),
			],
			result: undefined,
		};
	});
}

export async function deleteFolderTree(
	database: CloudflareDatabase,
	id: Folder.FolderId,
	userId: User.UserId,
) {
	const now = new Date();
	return atomic(database, async (snapshot) => {
		const [folder] = await snapshot.read((reader) =>
			reader.select().from(Db.folders).where(Dz.eq(Db.folders.id, id)).limit(1),
		);
		if (!folder) return { statements: [], result: undefined };
		await requireFolderAccess(snapshot, folder, userId);
		const descendants = Dz.sql`(with recursive descendants(id) as (select ${id} union select f.id from folders f inner join descendants d on f.parentId = d.id where f.organizationId = ${folder.organizationId} and f.spaceId is ${folder.spaceId}) select id from descendants)`;
		const descendantsRows = await snapshot.read((reader) =>
			reader
				.select()
				.from(Db.folders)
				.where(Dz.sql`${Db.folders.id} in ${descendants}`),
		);
		if (
			folder.spaceId === null &&
			descendantsRows.some((child) => child.createdById !== userId)
		)
			throw new Error("Descendant folder ownership changed");
		const [foreignChild] = await snapshot.read((reader) =>
			reader
				.select({ id: Db.folders.id })
				.from(Db.folders)
				.where(
					Dz.and(
						Dz.sql`${Db.folders.parentId} in ${descendants}`,
						Dz.or(
							Dz.ne(Db.folders.organizationId, folder.organizationId),
							Dz.sql`${Db.folders.spaceId} is not ${folder.spaceId}`,
						),
					),
				)
				.limit(1),
		);
		if (foreignChild)
			throw new Error(
				"Folder hierarchy crosses organization or space boundaries",
			);
		return {
			statements: [
				database
					.update(Db.videos)
					.set({ folderId: folder.parentId, updatedAt: now })
					.where(
						Dz.and(
							Dz.eq(Db.videos.orgId, folder.organizationId),
							Dz.sql`${Db.videos.folderId} in ${descendants}`,
							folder.spaceId === null ? undefined : Dz.sql`0`,
						),
					),
				database
					.update(Db.spaceVideos)
					.set({ folderId: folder.parentId })
					.where(
						Dz.and(
							Dz.sql`${Db.spaceVideos.folderId} in ${descendants}`,
							folder.spaceId
								? Dz.eq(Db.spaceVideos.spaceId, folder.spaceId)
								: Dz.sql`0`,
						),
					),
				database
					.delete(Db.folders)
					.where(Dz.sql`${Db.folders.id} in ${descendants}`),
			],
			result: undefined,
		};
	});
}
