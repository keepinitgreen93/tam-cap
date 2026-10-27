"use server";

import { getCurrentUser } from "@cap/database/auth/session";
import { db } from "@cap/database/cloudflare/application";
import { atomic } from "@cap/database/cloudflare/atomic";
import { videos } from "@cap/database/cloudflare/schema";
import { requireWritableVideo } from "@cap/web-backend/src/Videos/persistence";
import type { Video } from "@cap/web-domain";
import { eq, sql } from "drizzle-orm";
import { revalidatePath } from "next/cache";
import { enqueueVideoStorageNameSync } from "@/lib/sync-video-storage-names";

export async function editTitle(videoId: Video.VideoId, title: string) {
	const user = await getCurrentUser();

	if (!user || !title || !videoId) {
		throw new Error("Missing required data for updating video title");
	}

	const userId = user.id;
	const query = await db().select().from(videos).where(eq(videos.id, videoId));

	if (query.length === 0) {
		throw new Error("Video not found");
	}

	const video = query[0];
	if (!video) {
		throw new Error("Video not found");
	}

	if (video.ownerId !== userId) {
		throw new Error("You don't have permission to update this video");
	}

	try {
		const database = db();
		await atomic(database, async (snapshot) => {
			await requireWritableVideo(snapshot, videoId, userId);
			return {
				statements: [
					database
						.update(videos)
						.set({
							name: title,
							metadata: sql`json_set(coalesce(${videos.metadata}, json_object()), '$.titleManuallyEdited', json('true'))`,
						})
						.where(eq(videos.id, videoId)),
				],
				result: undefined,
			};
		});
		await enqueueVideoStorageNameSync(videoId);

		revalidatePath("/dashboard/caps");
		revalidatePath("/dashboard/shared-caps");
		revalidatePath(`/s/${videoId}`);

		return { success: true };
	} catch (error) {
		console.error("Error updating video title:", error);
		if (error instanceof Error) {
			throw new Error(error.message);
		}
		throw new Error("Failed to update video title");
	}
}
