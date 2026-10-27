"use server";
import { getCurrentUser } from "@cap/database/auth/session";
import { db } from "@cap/database/cloudflare/application";
import type { Organisation, Video } from "@cap/web-domain";
import { revalidatePath } from "next/cache";
import { mutateSharedVideos } from "@/lib/sharing-persistence";
export async function addVideosToOrganization(
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
			action: "add",
			mode: "member",
		});
		revalidatePath(`/dashboard/spaces/${organizationId}`);
		revalidatePath("/dashboard/caps");

		const totalUpdated = count;
		return {
			success: true,
			message: `${totalUpdated} video${
				totalUpdated === 1 ? "" : "s"
			} ${totalUpdated === 1 ? "is" : "are"} now in organization root`,
		};
	} catch (error) {
		console.error("Error adding videos to organization:", error);
		return {
			success: false,
			error:
				error instanceof Error
					? error.message
					: "Failed to add videos to organization",
		};
	}
}
