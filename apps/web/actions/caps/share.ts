"use server";
import { getCurrentUser } from "@cap/database/auth/session";
import { db } from "@cap/database/cloudflare/application";
import { type AtomicStatement, atomic } from "@cap/database/cloudflare/atomic";
import * as Db from "@cap/database/cloudflare/schema";
import { nanoId } from "@cap/database/helpers";
import { requireWritableVideo } from "@cap/web-backend/src/Videos/persistence";
import type { Space, Video } from "@cap/web-domain";
import { and, eq, not } from "drizzle-orm";
import { revalidatePath } from "next/cache";
import {
	idsIn,
	requireShareDestination,
	shareInsertRows,
} from "@/lib/sharing-persistence";

interface ShareCapParams {
	capId: Video.VideoId;
	spaceIds: Space.SpaceIdOrOrganisationId[];
	public?: boolean;
}
export async function shareCap({
	capId,
	spaceIds,
	public: isPublic,
}: ShareCapParams) {
	try {
		const user = await getCurrentUser();
		if (!user) return { success: false, error: "Unauthorized" };
		const requested = [...new Set(spaceIds)],
			entryIds = new Map(requested.map((id) => [id, nanoId()])),
			now = Date.now(),
			database = db();
		await atomic(database, async (snapshot) => {
			await requireWritableVideo(snapshot, capId, user.id);
			const organizations = await snapshot.read((reader) =>
				reader
					.select()
					.from(Db.organizations)
					.where(idsIn(Db.organizations.id, requested)),
			);
			const spaces = await snapshot.read((reader) =>
				reader.select().from(Db.spaces).where(idsIn(Db.spaces.id, requested)),
			);
			const currentOrg = await snapshot.read((reader) =>
				reader
					.select()
					.from(Db.sharedVideos)
					.where(eq(Db.sharedVideos.videoId, capId)),
			);
			const currentSpace = await snapshot.read((reader) =>
				reader
					.select()
					.from(Db.spaceVideos)
					.where(eq(Db.spaceVideos.videoId, capId)),
			);
			const existingOrg = new Set(currentOrg.map((row) => row.organizationId)),
				existingSpace = new Set(currentSpace.map((row) => row.spaceId));
			const known = new Set([
				...organizations.map((row) => row.id),
				...spaces.map((row) => row.id),
			]);
			if (requested.some((id) => !known.has(id)))
				throw new Error("Unauthorized");
			for (const organization of organizations)
				await requireShareDestination(
					snapshot,
					user.id,
					{ type: "organization", id: organization.id },
					"member",
				);
			for (const space of spaces)
				await requireShareDestination(
					snapshot,
					user.id,
					{ type: "space", id: space.id },
					"visible",
					existingSpace.has(space.id),
				);
			const orgIds = organizations.map((row) => row.id),
				spaceIds = spaces.map((row) => row.id),
				statements: AtomicStatement[] = [];
			if (currentOrg.some((row) => !orgIds.includes(row.organizationId)))
				statements.push(
					database
						.delete(Db.sharedVideos)
						.where(
							and(
								eq(Db.sharedVideos.videoId, capId),
								not(idsIn(Db.sharedVideos.organizationId, orgIds)),
							),
						),
				);
			if (currentSpace.some((row) => !spaceIds.includes(row.spaceId)))
				statements.push(
					database
						.delete(Db.spaceVideos)
						.where(
							and(
								eq(Db.spaceVideos.videoId, capId),
								not(idsIn(Db.spaceVideos.spaceId, spaceIds)),
							),
						),
				);
			const entry = (targetId: Space.SpaceIdOrOrganisationId) => {
				const id = entryIds.get(targetId);
				if (!id) throw new Error("Sharing identifier missing");
				return {
					id,
					targetId,
					videoId: capId,
					folderId: null,
					userId: user.id,
				};
			};
			const orgEntries = organizations
				.filter((row) => !existingOrg.has(row.id))
				.map((row) => entry(row.id));
			const spaceEntries = spaces
				.filter((row) => !existingSpace.has(row.id))
				.map((row) => entry(row.id));
			if (orgEntries.length)
				statements.push(
					shareInsertRows(database, "organization", orgEntries, now),
				);
			if (spaceEntries.length)
				statements.push(shareInsertRows(database, "space", spaceEntries, now));
			if (typeof isPublic === "boolean")
				statements.push(
					database
						.update(Db.videos)
						.set({ public: isPublic })
						.where(eq(Db.videos.id, capId)),
				);
			return { statements, result: undefined };
		});
		revalidatePath("/dashboard/caps");
		revalidatePath(`/dashboard/caps/${capId}`);
		return { success: true };
	} catch (error) {
		console.error("Error sharing cap:", error);
		return {
			success: false,
			error:
				error instanceof Error &&
				/Unauthorized|ownership changed|Space not found/.test(error.message)
					? "Unauthorized"
					: "Failed to update sharing settings",
		};
	}
}
