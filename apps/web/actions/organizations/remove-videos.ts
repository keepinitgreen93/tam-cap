"use server";
import { getCurrentUser } from "@cap/database/auth/session";
import { db } from "@cap/database/cloudflare/application";
import type { Organisation, Video } from "@cap/web-domain";
import { revalidatePath } from "next/cache";
import { mutateSharedVideos } from "@/lib/sharing-persistence";
export async function removeVideosFromOrganization(
	organizationId: Organisation.OrganisationId,
	videoIds: Video.VideoId[],
) {
	try {
		const user = await getCurrentUser();

		if (!user || !user.id) {
			throw new Error("Unauthorized");
		}

		if (!organizationId || !videoIds || videoIds.length === 0) {
			throw new Error("Missing required data");
		}

		const { count } = await mutateSharedVideos(db(), {
			userId: user.id,
			destination: { type: "organization", id: organizationId },
			videoIds,
			action: "remove",
			mode: "member",
			removeAnyOwner: true,
			clearPersonalFolders: true,
		});
		if (count === 0)
			return {
				success: true,
				message: "No matching shared videos found in organization",
			};
		revalidatePath(`/dashboard/spaces/${organizationId}`);
		revalidatePath("/dashboard/caps");

		return {
			success: true,
			message: `${count} video${
				count === 1 ? "" : "s"
			} removed from organization`,
		};
	} catch (error) {
		console.error("Error removing videos from organization:", error);
		return {
			success: false,
			error:
				error instanceof Error
					? error.message
					: "Failed to remove videos from organization",
		};
	}
}
