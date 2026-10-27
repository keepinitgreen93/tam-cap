"use server";
import { getCurrentUser } from "@cap/database/auth/session";
import { db } from "@cap/database/cloudflare/application";
import type { Space, Video } from "@cap/web-domain";
import { revalidatePath } from "next/cache";
import { mutateSharedVideos } from "@/lib/sharing-persistence";
export async function removeVideosFromSpace(
	spaceId: Space.SpaceIdOrOrganisationId,
	videoIds: Video.VideoId[],
) {
	try {
		const user = await getCurrentUser();

		if (!user || !user.id) {
			throw new Error("Unauthorized");
		}

		if (!spaceId || !videoIds || videoIds.length === 0) {
			throw new Error("Missing required data");
		}

		const isAllSpacesEntry = user.activeOrganizationId === spaceId;
		const { count } = await mutateSharedVideos(db(), {
			userId: user.id,
			destination: isAllSpacesEntry
				? { type: "organization", id: user.activeOrganizationId }
				: { type: "space", id: spaceId },
			videoIds,
			action: "remove",
			mode: "manager",
		});
		revalidatePath(`/dashboard/spaces/${spaceId}`);

		return {
			success: true,
			message: `Removed ${count} video(s) from ${isAllSpacesEntry ? "organization" : "space"} and folders`,
			deletedCount: count,
		};
	} catch (error) {
		return {
			success: false,
			message:
				error instanceof Error
					? error.message
					: "Failed to remove videos from space",
		};
	}
}
