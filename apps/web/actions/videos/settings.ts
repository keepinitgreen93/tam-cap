"use server";

import { getCurrentUser } from "@cap/database/auth/session";
import { db } from "@cap/database/cloudflare/application";
import { atomic } from "@cap/database/cloudflare/atomic";
import { videos } from "@cap/database/cloudflare/schema";
import { requireWritableVideo } from "@cap/web-backend/src/Videos/persistence";
import type { Video } from "@cap/web-domain";
import { eq, sql } from "drizzle-orm";
import { normalizePlaybackSpeed } from "@/lib/playback-speed";

const VIEWER_SETTING_KEYS = [
	"disableSummary",
	"disableCaptions",
	"disableChapters",
	"disableReactions",
	"disableTranscript",
	"disableComments",
] as const;

export async function updateVideoSettings(
	videoId: Video.VideoId,
	videoSettings: {
		disableSummary?: boolean;
		disableCaptions?: boolean;
		disableChapters?: boolean;
		disableReactions?: boolean;
		disableTranscript?: boolean;
		disableComments?: boolean;
		defaultPlaybackSpeed?: number;
	},
) {
	const user = await getCurrentUser();

	if (!user || !videoId || !videoSettings) {
		throw new Error("Missing required data for updating video settings");
	}

	const [video] = await db()
		.select()
		.from(videos)
		.where(eq(videos.id, videoId));

	if (!video) {
		throw new Error("Video not found for updating video settings");
	}

	if (video.ownerId !== user.id) {
		throw new Error("You don't have permission to update this video settings");
	}

	const settingsToSave: Record<string, boolean | number> = {};
	for (const key of VIEWER_SETTING_KEYS) {
		const value = videoSettings[key];
		if (typeof value === "boolean") settingsToSave[key] = value;
	}
	if (videoSettings.defaultPlaybackSpeed !== undefined) {
		settingsToSave.defaultPlaybackSpeed = normalizePlaybackSpeed(
			videoSettings.defaultPlaybackSpeed,
		);
	}

	const database = db();
	await atomic(database, async (snapshot) => {
		await requireWritableVideo(snapshot, videoId, user.id);
		return {
			statements: [
				database
					.update(videos)
					.set({
						settings: sql`json_patch(coalesce(${videos.settings}, json_object()), ${JSON.stringify(settingsToSave)})`,
					})
					.where(eq(videos.id, videoId)),
			],
			result: undefined,
		};
	});

	return { success: true };
}
