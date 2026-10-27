"use server";

import { serverEnv } from "@cap/env";
import { parseAdminVideoId, requireAdmin } from "@/lib/admin-access";
import { startAdminReprocess } from "@/lib/admin-reprocess-state";

export async function adminReprocessVideo(input: string) {
	await requireAdmin();
	const videoId = parseAdminVideoId(input);
	const { video } = await startAdminReprocess(videoId);
	return {
		videoId,
		name: video.name,
		shareUrl: `${serverEnv().WEB_URL}/s/${videoId}`,
	};
}
