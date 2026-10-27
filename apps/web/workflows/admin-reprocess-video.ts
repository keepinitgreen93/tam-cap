import { db } from "@cap/database/cloudflare/application";
import { videos } from "@cap/database/cloudflare/schema";
import { Video } from "@cap/web-domain";
import { eq } from "drizzle-orm";
import { FatalError } from "workflow";
import { startAdminReprocess } from "@/lib/admin-reprocess-state";
import { matchesProcessingRun } from "@/lib/video-processing-state";
import {
	type ProcessedVideoMetadata,
	waitForVideoProcessing,
} from "./video-processing-status";

async function dispatchAdminReprocess(videoId: string) {
	"use step";
	return startAdminReprocess(Video.VideoId.make(videoId));
}

export async function saveMetadataAndComplete(
	videoId: string,
	metadata: ProcessedVideoMetadata,
	processingToken: string,
): Promise<void> {
	"use step";
	const [video] = await db()
		.select()
		.from(videos)
		.where(eq(videos.id, Video.VideoId.make(videoId)))
		.limit(1);
	if (
		!processingToken ||
		!video ||
		!matchesProcessingRun(video, processingToken) ||
		video.metadata?.processingRun?.state !== "complete"
	)
		throw new FatalError("Reprocessing completion is not owned by this run");
	if (
		video.duration !== metadata.duration ||
		video.width !== metadata.width ||
		video.height !== metadata.height ||
		video.fps !== metadata.fps
	)
		throw new FatalError("Reprocessing completion metadata changed");
}

export async function adminReprocessVideoWorkflow(payload: {
	videoId: string;
}): Promise<{ success: boolean; message: string }> {
	"use workflow";
	const { token } = await dispatchAdminReprocess(payload.videoId);
	const metadata = await waitForVideoProcessing(payload.videoId, token);
	await saveMetadataAndComplete(payload.videoId, metadata, token);
	return { success: true, message: "Video reprocessing completed" };
}
