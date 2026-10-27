"use server";
import { getCurrentUser } from "@cap/database/auth/session";
import { db } from "@cap/database/cloudflare/application";
import type { Folder, Space, Video } from "@cap/web-domain";
import { revalidatePath } from "next/cache";
import { mutateSharedVideos } from "@/lib/sharing-persistence";
export async function addVideosToFolder(
	folderId: Folder.FolderId,
	videoIds: Video.VideoId[],
	spaceId: Space.SpaceIdOrOrganisationId,
) {
	try {
		const user = await getCurrentUser();

		if (!user || !user.id) {
			throw new Error("Unauthorized");
		}

		if (!folderId || !videoIds || videoIds.length === 0) {
			throw new Error("Missing required data");
		}
		const { count } = await mutateSharedVideos(db(), {
			userId: user.id,
			destination:
				spaceId === user.activeOrganizationId
					? { type: "organization", id: user.activeOrganizationId }
					: { type: "space", id: spaceId },
			folderId,
			videoIds,
			action: "add",
			mode: "member",
		});
		revalidatePath(`/dashboard/caps`);
		revalidatePath(`/dashboard/folder/${folderId}`);
		if (spaceId) {
			revalidatePath(`/dashboard/spaces/${spaceId}/folder/${folderId}`);
		}

		return {
			success: true,
			message: `${count} video${count === 1 ? "" : "s"} added to folder`,
			addedCount: count,
		};
	} catch (error) {
		console.error("Error adding videos to folder:", error);
		return {
			success: false,
			error:
				error instanceof Error
					? error.message
					: "Failed to add videos to folder",
		};
	}
}
