"use server";
import { getCurrentUser } from "@cap/database/auth/session";
import { db } from "@cap/database/cloudflare/application";
import type { Space, Video } from "@cap/web-domain";
import { revalidatePath } from "next/cache";
import { mutateSharedVideos } from "@/lib/sharing-persistence";
export async function addVideosToSpace(
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
			action: "add",
			mode: "manager",
		});
		revalidatePath(`/dashboard/spaces/${spaceId}`);
		revalidatePath("/dashboard/caps");

		return {
			success: true,
			message: `${count} video${count === 1 ? "" : "s"} added to ${isAllSpacesEntry ? "organization" : "space"}`,
		};
	} catch (error) {
		console.error("Error adding videos to space:", error);
		return {
			success: false,
			error:
				error instanceof Error
					? error.message
					: "Failed to add videos to space",
		};
	}
}
