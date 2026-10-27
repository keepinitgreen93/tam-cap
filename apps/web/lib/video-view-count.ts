import { db } from "@cap/database/cloudflare/application";
import { videos } from "@cap/database/cloudflare/schema";
import { Analytics } from "@cap/web-backend";
import { Video } from "@cap/web-domain";
import { eq } from "drizzle-orm";
import { Effect } from "effect";
import { runPromise } from "@/lib/server";

const DAY_IN_MS = 24 * 60 * 60 * 1000;
const MIN_RANGE_DAYS = 1;
const MAX_RANGE_DAYS = 90;
const DEFAULT_RANGE_DAYS = MAX_RANGE_DAYS;
const normalizeRangeDays = (rangeDays?: number) => {
	if (!Number.isFinite(rangeDays)) return DEFAULT_RANGE_DAYS;
	const normalized = Math.floor(rangeDays as number);
	if (normalized <= 0) return DEFAULT_RANGE_DAYS;
	return Math.max(MIN_RANGE_DAYS, Math.min(normalized, MAX_RANGE_DAYS));
};

export interface VideoViewCountOptions {
	rangeDays?: number;
}

export async function getVideoViewCount(
	videoId: string,
	options?: VideoViewCountOptions,
) {
	if (!videoId) throw new Error("Video ID is required");
	const [video] = await db()
		.select({ orgId: videos.orgId })
		.from(videos)
		.where(eq(videos.id, Video.VideoId.make(videoId)))
		.limit(1);
	if (!video) return { count: 0 };
	const to = new Date();
	const from = new Date(
		to.getTime() - normalizeRangeDays(options?.rangeDays) * DAY_IN_MS,
	);
	return runPromise(
		Effect.gen(function* () {
			const analytics = yield* Analytics;
			const rows = yield* analytics.countViews({
				organizationId: video.orgId,
				videoIds: [videoId],
				from,
				to,
			});
			return { count: rows[0]?.views ?? 0 };
		}),
	);
}
