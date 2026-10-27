import type { CloudflareDatabase } from "@cap/database/cloudflare";
import {
	type AtomicPlan,
	type AtomicSnapshot,
	atomic,
} from "@cap/database/cloudflare/atomic";
import type { videos } from "@cap/database/cloudflare/schema";
import { requireWritableVideo } from "@cap/web-backend/src/Videos/persistence";
import type { Video } from "@cap/web-domain";
import { Option } from "effect";

export function ownedRecordingPlan<T>(
	database: CloudflareDatabase,
	video: Pick<
		Video.Video,
		"id" | "ownerId" | "bucketId" | "storageIntegrationId"
	>,
	plan: (
		snapshot: AtomicSnapshot,
		current: typeof videos.$inferSelect,
	) => Promise<AtomicPlan<T>>,
) {
	return atomic(database, async (snapshot) => {
		const current = await requireWritableVideo(
			snapshot,
			video.id,
			video.ownerId,
		);
		if (
			current.bucket !== Option.getOrNull(video.bucketId) ||
			current.storageIntegrationId !==
				Option.getOrNull(video.storageIntegrationId)
		)
			throw new Error("Recording storage changed during upload");
		return plan(snapshot, current);
	});
}
