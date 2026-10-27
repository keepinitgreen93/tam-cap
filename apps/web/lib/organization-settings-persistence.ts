import { createHash } from "node:crypto";
import type { CloudflareDatabase } from "@cap/database/cloudflare";
import { requireOrganizationMember } from "@cap/database/cloudflare/access";
import type { AtomicSnapshot } from "@cap/database/cloudflare/atomic";
import {
	organizationMembers,
	spaceMembers,
	spaces,
} from "@cap/database/cloudflare/schema";
import type { Space, User } from "@cap/web-domain";
import { and, eq, sql } from "drizzle-orm";
import { canManageSpace, getEffectiveSpaceRole } from "@/lib/permissions/roles";

export async function requireManagedSpace(
	snapshot: AtomicSnapshot,
	userId: User.UserId,
	spaceId: Space.SpaceIdOrOrganisationId,
) {
	const [space] = await snapshot.read((reader) =>
		reader.select().from(spaces).where(eq(spaces.id, spaceId)).limit(1),
	);
	if (!space) throw new Error("Space not found");
	const access = await requireOrganizationMember(
		snapshot,
		space.organizationId,
		userId,
	);
	const [member] = await snapshot.read((reader) =>
		reader
			.select()
			.from(spaceMembers)
			.where(
				and(eq(spaceMembers.spaceId, spaceId), eq(spaceMembers.userId, userId)),
			)
			.limit(1),
	);
	if (
		!canManageSpace({
			organizationRole: access.role,
			spaceRole: getEffectiveSpaceRole({
				userId,
				createdById: space.createdById,
				memberRole: member?.role,
			}),
		})
	)
		throw new Error(
			"Only space admins, organization admins, and owners can manage this space",
		);
	return {
		...space,
		organizationOwnerId: access.organization.ownerId,
		canManage: true as const,
	};
}

export async function requireSpaceRoster(
	snapshot: AtomicSnapshot,
	space: Awaited<ReturnType<typeof requireManagedSpace>>,
	userIds: User.UserId[],
) {
	const members = await snapshot.read((reader) =>
		reader
			.select({ userId: organizationMembers.userId })
			.from(organizationMembers)
			.where(eq(organizationMembers.organizationId, space.organizationId)),
	);
	const allowed = new Set([
		space.organizationOwnerId,
		...members.map((member) => member.userId),
	]);
	if (userIds.some((id) => !allowed.has(id)))
		throw new Error("All space members must belong to the organization");
}

export function insertSpaceMembers(
	database: CloudflareDatabase,
	spaceId: Space.SpaceIdOrOrganisationId,
	members: { userId: User.UserId; role: "admin" | "member" }[],
	operationId: string,
	now: Date,
) {
	const rows = members.map((member) => ({
		...member,
		id: createHash("sha256")
			.update(`${operationId}:${member.userId}`)
			.digest("base64url")
			.slice(0, 15),
	}));
	return database.insert(spaceMembers).select(
		database
			.select({
				id: sql<string>`json_extract(value, '$.id')`,
				spaceId: sql<Space.SpaceIdOrOrganisationId>`${spaceId}`,
				userId: sql<User.UserId>`json_extract(value, '$.userId')`,
				role: sql<"admin" | "member">`json_extract(value, '$.role')`,
				createdAt: sql<Date>`${now.getTime()}`,
				updatedAt: sql<Date>`${now.getTime()}`,
			})
			.from(sql`json_each(${JSON.stringify(rows)})`),
	);
}
