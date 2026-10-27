"use server";
import { getCurrentUser } from "@cap/database/auth/session";
import { requireOrganizationMember } from "@cap/database/cloudflare/access";
import { db } from "@cap/database/cloudflare/application";
import { type AtomicStatement, atomic } from "@cap/database/cloudflare/atomic";
import {
	folders,
	sharedVideos,
	spaceVideos,
	videos,
} from "@cap/database/cloudflare/schema";
import { writableVideo } from "@cap/web-backend/src/Videos/persistence";
import type { Folder, Space, Video } from "@cap/web-domain";
import { and, eq } from "drizzle-orm";
import { revalidatePath } from "next/cache";
import { idsIn, requireShareDestination } from "@/lib/sharing-persistence";
export async function removeVideosFromFolder(
	folderId: Folder.FolderId,
	videoIds: Video.VideoId[],
	spaceId: Space.SpaceIdOrOrganisationId,
) {
	try {
		const user = await getCurrentUser();
		if (!user) throw new Error("Unauthorized");
		if (!folderId || !videoIds.length) throw new Error("Missing required data");
		const database = db();
		const result = await atomic(database, async (snapshot) => {
			const [folder] = await snapshot.read((reader) =>
				reader.select().from(folders).where(eq(folders.id, folderId)).limit(1),
			);
			if (!folder) throw new Error("Folder not found");
			if (!folder.spaceId) {
				await requireOrganizationMember(
					snapshot,
					folder.organizationId,
					user.id,
				);
				if (
					folder.createdById !== user.id ||
					folder.organizationId !== user.activeOrganizationId
				)
					throw new Error("Folder not found");
			} else {
				if (folder.spaceId !== spaceId) throw new Error("Folder not found");
				const access = await requireShareDestination(
					snapshot,
					user.id,
					folder.spaceId === folder.organizationId
						? { type: "organization", id: folder.organizationId }
						: { type: "space", id: folder.spaceId },
					"member",
				);
				if (access.organizationId !== folder.organizationId)
					throw new Error("Folder not found");
			}
			const owned = await snapshot.read((reader) =>
				reader
					.select({ id: videos.id })
					.from(videos)
					.where(
						and(
							writableVideo,
							eq(videos.ownerId, user.id),
							idsIn(videos.id, videoIds),
						),
					),
			);
			const valid = owned.map((row) => row.id);
			if (!valid.length) throw new Error("No valid videos found");
			const statements: AtomicStatement[] = [
				database
					.update(videos)
					.set({ folderId: null })
					.where(and(idsIn(videos.id, valid), eq(videos.folderId, folderId))),
			];
			if (!folder.spaceId || folder.spaceId === folder.organizationId)
				statements.push(
					database
						.update(sharedVideos)
						.set({ folderId: null })
						.where(
							and(
								eq(sharedVideos.organizationId, folder.organizationId),
								idsIn(sharedVideos.videoId, valid),
								eq(sharedVideos.folderId, folderId),
							),
						),
				);
			else
				statements.push(
					database
						.update(spaceVideos)
						.set({ folderId: null })
						.where(
							and(
								eq(spaceVideos.spaceId, folder.spaceId),
								idsIn(spaceVideos.videoId, valid),
								eq(spaceVideos.folderId, folderId),
							),
						),
				);
			return {
				statements,
				result: { count: valid.length, spaceId: folder.spaceId },
			};
		});
		revalidatePath("/dashboard/caps");
		revalidatePath(`/dashboard/folder/${folderId}`);
		if (result.spaceId)
			revalidatePath(`/dashboard/spaces/${result.spaceId}/folder/${folderId}`);
		return {
			success: true,
			message: `${result.count} video${result.count === 1 ? "" : "s"} removed from folder`,
			removedCount: result.count,
		};
	} catch (error) {
		console.error("Error removing videos from folder:", error);
		return {
			success: false,
			error:
				error instanceof Error
					? error.message
					: "Failed to remove videos from folder",
		};
	}
}
