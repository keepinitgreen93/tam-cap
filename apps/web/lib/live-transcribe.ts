import { randomUUID } from "node:crypto";
import { requireActiveOrganization } from "@cap/database/cloudflare/access";
import { db } from "@cap/database/cloudflare/application";
import { atomic } from "@cap/database/cloudflare/atomic";
import { videos } from "@cap/database/cloudflare/schema";
import { serverEnv } from "@cap/env";
import type { Organisation, User, Video } from "@cap/web-domain";
import { eq } from "drizzle-orm";
import { start } from "workflow/api";
import { liveTranscribeWorkflow } from "@/workflows/live-transcribe";
import { isTranscriptionConfigured } from "./transcription-config";

export type LiveTranscriptionStart = "started" | "skipped";

export async function maybeStartLiveTranscription({
	videoId,
	ownerId,
	orgId,
}: {
	videoId: Video.VideoId;
	ownerId: User.UserId;
	orgId: Organisation.OrganisationId;
}): Promise<LiveTranscriptionStart> {
	try {
		if (!isTranscriptionConfigured(serverEnv())) return "skipped";
		const runId = randomUUID();
		const updatedAt = new Date().toISOString();
		const database = db();
		const claimed = await atomic(database, async (snapshot) => {
			const organization = await requireActiveOrganization(snapshot, orgId);
			const [video] = await snapshot.read((reader) =>
				reader.select().from(videos).where(eq(videos.id, videoId)).limit(1),
			);
			if (
				!video ||
				video.ownerId !== ownerId ||
				video.orgId !== orgId ||
				video.metadata?.liveTranscript ||
				video.transcriptionStatus === "COMPLETE" ||
				(video.settings?.disableTranscript ??
					organization.settings?.disableTranscript)
			)
				return { statements: [], result: false };
			return {
				statements: [
					database
						.update(videos)
						.set({
							metadata: {
								...video.metadata,
								liveTranscript: { id: runId, status: "active", updatedAt },
							},
							updatedAt: video.updatedAt,
						})
						.where(eq(videos.id, videoId)),
				],
				result: true,
			};
		});
		if (!claimed) return "skipped";
		await start(liveTranscribeWorkflow, [{ videoId, userId: ownerId, runId }]);
		return "started";
	} catch (error) {
		console.warn(`[maybeStartLiveTranscription] Failed for ${videoId}`, error);
		return "skipped";
	}
}
