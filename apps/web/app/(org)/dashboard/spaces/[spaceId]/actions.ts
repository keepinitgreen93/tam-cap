"use server";

import { getCurrentUser } from "@cap/database/auth/session";
import { db } from "@cap/database/cloudflare/application";
import { atomic } from "@cap/database/cloudflare/atomic";
import { spaceMembers } from "@cap/database/cloudflare/schema";
import { Space, User } from "@cap/web-domain";
import { eq, sql } from "drizzle-orm";
import { revalidatePath } from "next/cache";
import { v4 as uuidv4 } from "uuid";
import { z } from "zod";
import {
	insertSpaceMembers,
	requireManagedSpace,
	requireSpaceRoster,
} from "@/lib/organization-settings-persistence";
import {
	canRemoveSpaceMember,
	normalizeSpaceRole,
} from "@/lib/permissions/roles";

const spaceRole = z.preprocess(
	(value) => (value === "Admin" ? "admin" : value),
	z.union([z.literal("admin"), z.literal("member")]),
);

const spaceMemberRoleSchema = z.object({
	userId: z.string().transform((v) => User.UserId.make(v)),
	role: spaceRole,
});

const addSpaceMemberSchema = z.object({
	spaceId: z.string().transform((v) => Space.SpaceId.make(v)),
	userId: z.string().transform((v) => User.UserId.make(v)),
	role: spaceRole,
});

const addSpaceMembersSchema = z.object({
	spaceId: z.string().transform((v) => Space.SpaceId.make(v)),
	userIds: z.array(z.string().transform((v) => User.UserId.make(v))),
	role: spaceRole,
});

export async function addSpaceMember(
	data: z.infer<typeof addSpaceMemberSchema>,
) {
	const validation = addSpaceMemberSchema.safeParse(data);
	if (!validation.success) throw new Error("Invalid input");
	const result = await addSpaceMembers({
		spaceId: validation.data.spaceId,
		userIds: [validation.data.userId],
		role: validation.data.role,
	});
	return { success: result.success };
}

export async function addSpaceMembers(
	data: z.infer<typeof addSpaceMembersSchema>,
) {
	const validation = addSpaceMembersSchema.safeParse(data);
	if (!validation.success) {
		throw new Error("Invalid input");
	}

	const currentUser = await getCurrentUser();
	if (!currentUser) {
		throw new Error("Unauthorized");
	}

	const { spaceId, userIds, role } = validation.data;
	const database = db();
	const operationId = uuidv4();
	const now = new Date();
	const result = await atomic(database, async (snapshot) => {
		const access = await requireManagedSpace(snapshot, currentUser.id, spaceId);
		await requireSpaceRoster(snapshot, access, userIds);
		const existing = await snapshot.read((reader) =>
			reader
				.select({ userId: spaceMembers.userId })
				.from(spaceMembers)
				.where(eq(spaceMembers.spaceId, spaceId)),
		);
		const existingIds = new Set(existing.map((member) => member.userId));
		const added = Array.from(new Set(userIds)).filter(
			(id) => !existingIds.has(id),
		);
		return {
			statements: added.length
				? [
						insertSpaceMembers(
							database,
							spaceId,
							added.map((userId) => ({
								userId,
								role: userId === access.createdById ? "admin" : role,
							})),
							operationId,
							now,
						),
					]
				: [],
			result: { success: true, added, alreadyMembers: Array.from(existingIds) },
		};
	});
	revalidatePath(`/dashboard/spaces/${spaceId}`);
	return result;
}

const removeSpaceMemberSchema = z.object({
	memberId: z.string(),
});

export async function removeSpaceMember(
	data: z.infer<typeof removeSpaceMemberSchema>,
) {
	const validation = removeSpaceMemberSchema.safeParse(data);
	if (!validation.success) throw new Error("Invalid input");
	const result = await batchRemoveSpaceMembers({
		memberIds: [validation.data.memberId],
	});
	if (!result.removed.length) throw new Error("Member not found");
	return { success: true };
}

const setSpaceMembersSchema = z.object({
	spaceId: z
		.string()
		.transform((v) => Space.SpaceId.make(v) as Space.SpaceIdOrOrganisationId),
	userIds: z.array(z.string().transform((v) => User.UserId.make(v))),
	role: spaceRole.default("member"),
	members: z.array(spaceMemberRoleSchema).optional(),
});

export async function setSpaceMembers(
	data: z.infer<typeof setSpaceMembersSchema>,
) {
	const validation = setSpaceMembersSchema.safeParse(data);
	if (!validation.success) {
		throw new Error("Invalid input");
	}
	const currentUser = await getCurrentUser();
	if (!currentUser) {
		throw new Error("Unauthorized");
	}
	const { spaceId, userIds, role, members } = validation.data;

	const database = db();
	const operationId = uuidv4();
	const now = new Date();
	const result = await atomic(database, async (snapshot) => {
		const access = await requireManagedSpace(snapshot, currentUser.id, spaceId);
		const roles = new Map(
			(members ?? userIds.map((userId) => ({ userId, role }))).map((member) => [
				member.userId,
				normalizeSpaceRole(member.role) ?? "member",
			]),
		);
		const allowed = await requireSpaceRoster(
			snapshot,
			access,
			Array.from(roles.keys()),
		);
		if (allowed.has(access.createdById)) roles.set(access.createdById, "admin");
		const values = Array.from(roles, ([userId, role]) => ({ userId, role }));
		return {
			statements: [
				database.delete(spaceMembers).where(eq(spaceMembers.spaceId, spaceId)),
				insertSpaceMembers(database, spaceId, values, operationId, now),
			],
			result: { success: true, count: values.length },
		};
	});
	revalidatePath(`/dashboard/spaces/${spaceId}`);
	return result;
}

const batchRemoveSpaceMembersSchema = z.object({
	memberIds: z.array(z.string()),
});

export async function batchRemoveSpaceMembers(
	data: z.infer<typeof batchRemoveSpaceMembersSchema>,
) {
	const validation = batchRemoveSpaceMembersSchema.safeParse(data);
	if (!validation.success) {
		throw new Error("Invalid input");
	}

	const currentUser = await getCurrentUser();
	if (!currentUser) {
		throw new Error("Unauthorized");
	}

	const { memberIds } = validation.data;
	if (memberIds.length === 0) {
		return { success: true, removed: [] };
	}

	const database = db();
	const predicate = sql`${spaceMembers.id} in (select value from json_each(${JSON.stringify(memberIds)}))`;
	const result = await atomic(database, async (snapshot) => {
		const members = await snapshot.read((reader) =>
			reader.select().from(spaceMembers).where(predicate),
		);
		const spaceId = members[0]?.spaceId;
		if (!spaceId)
			return {
				statements: [],
				result: { spaceId: null, removed: [] as string[] },
			};
		if (members.some((member) => member.spaceId !== spaceId))
			throw new Error("Cannot remove members from multiple spaces at once");
		const access = await requireManagedSpace(snapshot, currentUser.id, spaceId);
		if (
			members.some(
				(member) =>
					!canRemoveSpaceMember({
						canManage: access.canManage,
						targetUserId: member.userId,
						createdById: access.createdById,
					}),
			)
		)
			throw new Error(
				"You do not have permission to remove one or more members",
			);
		return {
			statements: [database.delete(spaceMembers).where(predicate)],
			result: { spaceId, removed: members.map((member) => member.id) },
		};
	});
	if (result.spaceId) revalidatePath(`/dashboard/spaces/${result.spaceId}`);
	return { success: true, removed: result.removed };
}
