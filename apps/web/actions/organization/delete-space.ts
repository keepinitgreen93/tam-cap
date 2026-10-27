"use server";

import { getCurrentUser } from "@cap/database/auth/session";
import { requireActiveOrganization } from "@cap/database/cloudflare/access";
import { db } from "@cap/database/cloudflare/application";
import { atomic } from "@cap/database/cloudflare/atomic";
import {
	folders,
	organizationMembers,
	spaceMembers,
	spaces,
	spaceVideos,
} from "@cap/database/cloudflare/schema";
import { S3Buckets } from "@cap/web-backend";
import type { Space } from "@cap/web-domain";
import { and, eq } from "drizzle-orm";
import { Effect, Option } from "effect";
import { revalidatePath } from "next/cache";
import {
	canManageSpace,
	getEffectiveOrganizationRole,
	getEffectiveSpaceRole,
} from "@/lib/permissions/roles";
import { runPromise } from "@/lib/server";
import { requireSpaceManager } from "./space-authorization";

interface DeleteSpaceResponse {
	success: boolean;
	error?: string;
}

export async function deleteSpace(
	spaceId: Space.SpaceIdOrOrganisationId,
): Promise<DeleteSpaceResponse> {
	try {
		const user = await getCurrentUser();

		if (!user || !user.activeOrganizationId) {
			return {
				success: false,
				error: "User not logged in or no active organization",
			};
		}

		const space = await db()
			.select()
			.from(spaces)
			.where(eq(spaces.id, spaceId))
			.limit(1);

		if (!space || space.length === 0) {
			return {
				success: false,
				error: "Space not found",
			};
		}

		const spaceData = space[0];
		const access = await requireSpaceManager(user.id, spaceId).catch(
			() => null,
		);
		if (!spaceData || !access) {
			return {
				success: false,
				error: "You don't have permission to delete this space",
			};
		}

		const database = db();
		const deletedOrganizationId = await atomic(database, async (snapshot) => {
			const [current] = await snapshot.read((reader) =>
				reader.select().from(spaces).where(eq(spaces.id, spaceId)).limit(1),
			);
			if (!current) throw new Error("Space not found");
			const organization = await requireActiveOrganization(
				snapshot,
				current.organizationId,
			);
			const [organizationMember] = await snapshot.read((reader) =>
				reader
					.select()
					.from(organizationMembers)
					.where(
						and(
							eq(organizationMembers.organizationId, organization.id),
							eq(organizationMembers.userId, user.id),
						),
					)
					.limit(1),
			);
			const [spaceMember] = await snapshot.read((reader) =>
				reader
					.select()
					.from(spaceMembers)
					.where(
						and(
							eq(spaceMembers.spaceId, spaceId),
							eq(spaceMembers.userId, user.id),
						),
					)
					.limit(1),
			);
			if (
				!canManageSpace({
					organizationRole: getEffectiveOrganizationRole({
						userId: user.id,
						ownerId: organization.ownerId,
						memberRole: organizationMember?.role,
					}),
					spaceRole: getEffectiveSpaceRole({
						userId: user.id,
						createdById: current.createdById,
						memberRole: spaceMember?.role,
					}),
				})
			)
				throw new Error("You don't have permission to delete this space");
			return {
				statements: [
					database.delete(spaceVideos).where(eq(spaceVideos.spaceId, spaceId)),
					database
						.delete(spaceMembers)
						.where(eq(spaceMembers.spaceId, spaceId)),
					database.delete(folders).where(eq(folders.spaceId, spaceId)),
					database.delete(spaces).where(eq(spaces.id, spaceId)),
				],
				result: organization.id,
			};
		});

		try {
			await Effect.gen(function* () {
				const [bucket] = yield* S3Buckets.getBucketAccess(Option.none());

				const listedObjects = yield* bucket.listObjects({
					prefix: `organizations/${deletedOrganizationId}/spaces/${spaceId}/`,
				});

				if (listedObjects.Contents) {
					yield* bucket.deleteObjects(
						listedObjects.Contents.map((content) => ({
							Key: content.Key,
						})),
					);

					console.log(
						`Deleted ${listedObjects.Contents.length} objects for space ${spaceId}`,
					);
				}
			}).pipe(runPromise);
		} catch (error) {
			console.error("Error deleting space icons from S3:", error);
		}

		revalidatePath("/dashboard");

		return {
			success: true,
		};
	} catch (error) {
		console.error("Error deleting space:", error);
		return {
			success: false,
			error: "Failed to delete space",
		};
	}
}
