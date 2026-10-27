"use server";

import { getCurrentUser } from "@cap/database/auth/session";
import { db } from "@cap/database/cloudflare/application";
import { atomic } from "@cap/database/cloudflare/atomic";
import { videos } from "@cap/database/cloudflare/schema";
import { userIsPro } from "@cap/utils";
import { requireWritableVideo } from "@cap/web-backend/src/Videos/persistence";
import type { Video } from "@cap/web-domain";
import { and, eq, sql } from "drizzle-orm";
import {
	type CallToActionErrors,
	type CallToActionInput,
	type ShareCallToAction,
	toStoredCallToAction,
	validateCallToAction,
} from "@/lib/share-call-to-action";

export type UpdateVideoCallToActionResult =
	| { success: true; callToAction: ShareCallToAction | null }
	| { success: false; errors: CallToActionErrors; upgradeRequired?: true };

export async function updateVideoCallToAction(
	videoId: Video.VideoId,
	input: CallToActionInput | null,
): Promise<UpdateVideoCallToActionResult> {
	const user = await getCurrentUser();
	if (!user) throw new Error("Unauthorized");
	if (!videoId) throw new Error("Missing video");

	const [video] = await db()
		.select({ ownerId: videos.ownerId })
		.from(videos)
		.where(eq(videos.id, videoId));

	if (!video) throw new Error("Video not found");
	if (video.ownerId !== user.id) {
		throw new Error("You don't have permission to update this video");
	}
	if (!userIsPro(user)) {
		return { success: false, errors: {}, upgradeRequired: true };
	}

	if (input === null) {
		await atomic(db(), async (snapshot) => {
			await requireWritableVideo(snapshot, videoId, user.id);
			return {
				statements: [
					db()
						.update(videos)
						.set({
							settings: sql`json_patch(COALESCE(${videos.settings}, JSON_OBJECT()), '{"callToAction":null}')`,
						})
						.where(and(eq(videos.id, videoId), eq(videos.ownerId, user.id))),
				],
				result: undefined,
			};
		});
		return { success: true, callToAction: null };
	}

	const result = validateCallToAction(input);
	if (!result.ok) return { success: false, errors: result.errors };

	await atomic(db(), async (snapshot) => {
		await requireWritableVideo(snapshot, videoId, user.id);
		return {
			statements: [
				db()
					.update(videos)
					.set({
						settings: sql`json_patch(json_patch(COALESCE(${videos.settings}, JSON_OBJECT()), '{"callToAction":null}'), ${JSON.stringify({ callToAction: toStoredCallToAction(result.value) })})`,
					})
					.where(and(eq(videos.id, videoId), eq(videos.ownerId, user.id))),
			],
			result: undefined,
		};
	});

	return { success: true, callToAction: result.value };
}
