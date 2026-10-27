import { db } from "@cap/database/cloudflare/application";
import { comments, spaceVideos, videos } from "@cap/database/cloudflare/schema";
import { Analytics } from "@cap/web-backend";
import { and, between, eq } from "drizzle-orm";
import { type SQL, sql } from "drizzle-orm/sql";
import { Effect } from "effect";

import { videoBelongsToOrganization } from "@/lib/cap-analytics-access";
import { runPromise } from "@/lib/server";

import type {
	AnalyticsRange,
	BreakdownRow,
	OrgAnalyticsResponse,
} from "./types";

type VideoRow = typeof videos.$inferSelect;
type OrgId = VideoRow["orgId"];
type VideoId = VideoRow["id"];
type SpaceVideoRow = typeof spaceVideos.$inferSelect;
type SpaceOrOrgId = SpaceVideoRow["spaceId"];

type CountSeriesRow = { bucket: string; count: number };
type ViewSeriesRow = { bucket: string; views: number };
type BreakdownSourceRow = { name: string; views: number; subtitle?: string };
type TopCapRow = { videoId: string; views: number };

type AnalyticsData = {
	viewSeries: ViewSeriesRow[];
	countries: BreakdownSourceRow[];
	cities: BreakdownSourceRow[];
	browsers: BreakdownSourceRow[];
	devices: BreakdownSourceRow[];
	operatingSystems: BreakdownSourceRow[];
	topCapsRaw: TopCapRow[];
};

type RollingAnalyticsRange = Exclude<AnalyticsRange, "lifetime">;

const ROLLING_RANGE_CONFIG: Record<
	RollingAnalyticsRange,
	{ hours: number; bucket: "hour" | "day" }
> = {
	"24h": { hours: 24, bucket: "hour" },
	"7d": { hours: 7 * 24, bucket: "day" },
	"30d": { hours: 30 * 24, bucket: "day" },
};

const LIFETIME_FALLBACK_DAYS = 30;

// Escape backslashes BEFORE quotes: ClickHouse honors C-style `\'` inside
// single-quoted literals, so doubling quotes alone lets a trailing backslash
// neutralise the doubled quote and break out of the string (SQL injection).
const normalizeBucket = (
	input: string | null | undefined,
	bucket: "hour" | "day",
) => {
	if (!input) return undefined;
	if (input.endsWith("Z")) return input;
	if (bucket === "day" && input.length === 10) return `${input}T00:00:00Z`;
	return `${input.replace(" ", "T")}Z`;
};

const formatBucketTimestamp = (value: Date) =>
	`${value.toISOString().slice(0, 19)}Z`;

const buildBuckets = (from: Date, to: Date, bucket: "hour" | "day") => {
	const size = bucket === "hour" ? 60 * 60 * 1000 : 24 * 60 * 60 * 1000;
	const buckets: string[] = [];
	const start = Math.floor(from.getTime() / size) * size;
	const end = Math.floor(to.getTime() / size) * size;
	for (let ts = start; ts <= end; ts += size) {
		buckets.push(formatBucketTimestamp(new Date(ts)));
	}
	return buckets;
};

const getLifetimeRangeStart = async (
	orgId: OrgId,
	videoIds?: VideoId[],
): Promise<Date | undefined> => {
	const whereClause =
		videoIds && videoIds.length > 0
			? and(
					eq(videos.orgId, orgId),
					sql`${videos.id} in (select value from json_each(${JSON.stringify(videoIds)}))`,
				)
			: eq(videos.orgId, orgId);

	const rows = await db()
		.select({ minCreatedAt: sql<Date>`MIN(${videos.createdAt})` })
		.from(videos)
		.where(whereClause)
		.limit(1);

	const candidate = rows[0]?.minCreatedAt;
	if (!candidate) return undefined;
	return candidate instanceof Date ? candidate : new Date(candidate);
};

const resolveRangeBounds = async (
	range: AnalyticsRange,
	orgId: OrgId,
	videoIds?: VideoId[],
): Promise<{ from: Date; to: Date; bucket: "hour" | "day" }> => {
	const to = new Date();

	if (range === "lifetime") {
		const lifetimeStart = await getLifetimeRangeStart(orgId, videoIds);
		const fallbackFrom = new Date(
			to.getTime() - LIFETIME_FALLBACK_DAYS * 24 * 60 * 60 * 1000,
		);
		const from =
			lifetimeStart && lifetimeStart < to ? lifetimeStart : fallbackFrom;
		return { from, to, bucket: "day" };
	}

	const config = ROLLING_RANGE_CONFIG[range];
	const from = new Date(to.getTime() - config.hours * 60 * 60 * 1000);
	return { from, to, bucket: config.bucket };
};

const getSpaceVideoIds = async (spaceId: SpaceOrOrgId): Promise<VideoId[]> => {
	const rows = await db()
		.select({ videoId: spaceVideos.videoId })
		.from(spaceVideos)
		.where(eq(spaceVideos.spaceId, spaceId));
	return rows.map((row) => row.videoId);
};

export const getOrgAnalyticsData = async (
	orgId: string,
	range: AnalyticsRange,
	spaceId?: string,
	capId?: string,
): Promise<OrgAnalyticsResponse> => {
	const typedOrgId = orgId as OrgId;

	const spaceVideoIds = spaceId
		? await getSpaceVideoIds(spaceId as SpaceOrOrgId)
		: undefined;
	const capVideoIds = capId ? [capId as VideoId] : undefined;
	const videoIds = capVideoIds || spaceVideoIds;

	const { from, to, bucket } = await resolveRangeBounds(
		range,
		typedOrgId,
		videoIds,
	);
	const buckets = buildBuckets(from, to, bucket);

	if (
		(spaceId && spaceVideoIds && spaceVideoIds.length === 0) ||
		(capId && !capVideoIds)
	) {
		let capName: string | undefined;
		if (capId) {
			const capNames = await loadVideoNames([capId]);
			capName = capNames.get(capId);
		}
		return {
			counts: {
				caps: 0,
				views: 0,
				comments: 0,
				reactions: 0,
			},
			chart: buckets.map((bucket) => ({
				bucket,
				caps: 0,
				views: 0,
				comments: 0,
				reactions: 0,
			})),
			breakdowns: {
				countries: [],
				cities: [],
				browsers: [],
				operatingSystems: [],
				devices: [],
				topCaps: [],
			},
			capName,
		};
	}

	const [capsSeries, commentSeries, reactionSeries] = await Promise.all([
		queryVideoSeries(typedOrgId, from, to, bucket, videoIds),
		queryCommentsSeries(typedOrgId, from, to, "text", bucket, videoIds),
		queryCommentsSeries(typedOrgId, from, to, "emoji", bucket, videoIds),
	]);

	const analyticsData = await runPromise(
		Effect.gen(function* () {
			const analytics = yield* Analytics;
			const scope = { organizationId: typedOrgId, from, to, videoIds };
			const [
				viewSeries,
				countries,
				cityRows,
				browsers,
				devices,
				operatingSystems,
				topCapsRaw,
			] = yield* Effect.all(
				[
					analytics.viewSeries(scope, bucket),
					analytics.breakdown(scope, "country"),
					analytics.cityBreakdown(scope),
					analytics.breakdown(scope, "browser"),
					analytics.breakdown(scope, "device"),
					analytics.breakdown(scope, "os"),
					capId ? Effect.succeed([]) : analytics.topCaps(scope),
				],
				{ concurrency: 4 },
			);
			return {
				viewSeries,
				countries,
				cities: cityRows.map((row) => ({
					name: row.name,
					subtitle: row.country,
					views: row.views,
				})),
				browsers,
				devices,
				operatingSystems,
				topCapsRaw,
			} satisfies AnalyticsData;
		}),
	);

	const totalViews = analyticsData.viewSeries.reduce(
		(sum: number, row: ViewSeriesRow) => sum + row.views,
		0,
	);
	const totalCaps = capsSeries.reduce(
		(sum: number, row: CountSeriesRow) => sum + row.count,
		0,
	);
	const totalComments = commentSeries.reduce(
		(sum: number, row: CountSeriesRow) => sum + row.count,
		0,
	);
	const totalReactions = reactionSeries.reduce(
		(sum: number, row: CountSeriesRow) => sum + row.count,
		0,
	);

	const chartData = buckets.map((bucket) => ({
		bucket,
		caps:
			capsSeries.find((row: CountSeriesRow) => row.bucket === bucket)?.count ??
			0,
		views:
			analyticsData.viewSeries.find(
				(row: ViewSeriesRow) => row.bucket === bucket,
			)?.views ?? 0,
		comments:
			commentSeries.find((row: CountSeriesRow) => row.bucket === bucket)
				?.count ?? 0,
		reactions:
			reactionSeries.find((row: CountSeriesRow) => row.bucket === bucket)
				?.count ?? 0,
	}));

	const videoNames = await loadVideoNames(
		analyticsData.topCapsRaw
			.map((cap: TopCapRow) => cap.videoId)
			.filter(Boolean),
		videoBelongsToOrganization(typedOrgId),
	);

	let capName: string | undefined;
	if (capId) {
		const capNames = await loadVideoNames([capId]);
		capName = capNames.get(capId);
	}

	return {
		counts: {
			caps: totalCaps,
			views: totalViews,
			comments: totalComments,
			reactions: totalReactions,
		},
		chart: chartData,
		breakdowns: {
			countries: formatBreakdown(
				analyticsData.countries,
				totalViews,
				(row) => row.name,
			),
			cities: formatBreakdown(
				analyticsData.cities,
				totalViews,
				(row) => row.name,
			),
			browsers: normalizeAndAggregate(
				analyticsData.browsers,
				totalViews,
				(row) => row.name,
				normalizeBrowserName,
			),
			operatingSystems: normalizeAndAggregate(
				analyticsData.operatingSystems,
				totalViews,
				(row) => row.name,
				normalizeOSName,
			),
			devices: normalizeAndAggregate(
				analyticsData.devices,
				totalViews,
				(row) => row.name,
				normalizeDeviceName,
			),
			topCaps: analyticsData.topCapsRaw.map((row: TopCapRow) => ({
				id: row.videoId,
				name: videoNames.get(row.videoId) ?? row.videoId,
				views: row.views,
				percentage: totalViews > 0 ? row.views / totalViews : 0,
			})),
		},
		capName,
	};
};

const normalizeOSName = (name: string): string => {
	if (!name || typeof name !== "string") return name || "Unknown";
	const normalized = name.trim();
	if (!normalized) return "Unknown";
	const lower = normalized.toLowerCase();

	if (
		lower.includes("mac") ||
		lower === "macos" ||
		lower === "mac os" ||
		lower === "darwin"
	) {
		return "macOS";
	}
	if (lower.includes("windows") || lower === "win") {
		return "Windows";
	}
	if (lower.includes("linux")) {
		return "Linux";
	}
	if (lower.includes("android")) {
		return "Android";
	}
	if (lower.includes("ios") || lower === "iphone os") {
		return "iOS";
	}
	if (lower.includes("ubuntu")) {
		return "Ubuntu";
	}
	if (lower.includes("fedora")) {
		return "Fedora";
	}

	return normalized;
};

const normalizeDeviceName = (name: string): string => {
	if (!name || typeof name !== "string") return name || "Unknown";
	const normalized = name.trim();
	if (!normalized) return "Unknown";
	const lower = normalized.toLowerCase();

	if (lower === "desktop" || lower === "desktop computer" || lower === "pc") {
		return "Desktop";
	}
	if (lower === "mobile" || lower === "smartphone" || lower === "phone") {
		return "Mobile";
	}
	if (lower === "tablet" || lower === "ipad") {
		return "Tablet";
	}

	return normalized;
};

const normalizeBrowserName = (name: string): string => {
	if (!name || typeof name !== "string") return name || "Unknown";
	const normalized = name.trim();
	if (!normalized) return "Unknown";
	const lower = normalized.toLowerCase();

	if (lower.includes("chrome") && !lower.includes("chromium")) {
		return "Chrome";
	}
	if (lower.includes("firefox")) {
		return "Firefox";
	}
	if (lower.includes("safari")) {
		return "Safari";
	}
	if (lower.includes("edge")) {
		return "Edge";
	}
	if (lower.includes("opera")) {
		return "Opera";
	}
	if (lower.includes("brave")) {
		return "Brave";
	}
	if (lower.includes("internet explorer") || lower === "ie") {
		return "Internet Explorer";
	}

	return normalized;
};

const normalizeAndAggregate = <T extends { name: string; views: number }>(
	rows: T[],
	totalViews: number,
	getName: (row: T) => string,
	normalizeFn: (name: string) => string,
): BreakdownRow[] => {
	const aggregated = new Map<string, number>();

	for (const row of rows) {
		const originalName = getName(row);
		const normalizedName = normalizeFn(originalName);
		const currentViews = aggregated.get(normalizedName) ?? 0;
		aggregated.set(normalizedName, currentViews + row.views);
	}

	return Array.from(aggregated.entries())
		.map(([name, views]) => ({
			name,
			views,
			percentage: totalViews > 0 ? views / totalViews : 0,
		}))
		.sort((a, b) => b.views - a.views);
};

const formatBreakdown = <T extends { name: string; views: number }>(
	rows: T[],
	totalViews: number,
	getName: (row: T) => string,
): BreakdownRow[] =>
	rows.map((row) => ({
		name: getName(row),
		views: row.views,
		percentage: totalViews > 0 ? row.views / totalViews : 0,
	}));

const loadVideoNames = async (videoIds: ReadonlyArray<string>, scope?: SQL) => {
	if (videoIds.length === 0) return new Map<string, string>();
	const typedVideoIds = videoIds.map((id) => id as VideoId);
	const records = await db()
		.select({ id: videos.id, name: videos.name })
		.from(videos)
		.where(
			and(
				sql`${videos.id} in (select value from json_each(${JSON.stringify(typedVideoIds)}))`,
				scope,
			),
		);
	return new Map(records.map((record) => [record.id, record.name]));
};

const queryVideoSeries = async (
	orgId: OrgId,
	from: Date,
	to: Date,
	bucket: "hour" | "day",
	spaceVideoIds?: VideoId[],
): Promise<CountSeriesRow[]> => {
	const bucketExpr =
		bucket === "hour"
			? sql<string>`strftime('%Y-%m-%dT%H:00:00Z', ${videos.createdAt} / 1000, 'unixepoch')`
			: sql<string>`strftime('%Y-%m-%dT00:00:00Z', ${videos.createdAt} / 1000, 'unixepoch')`;

	const conditions = [
		eq(videos.orgId, orgId),
		between(videos.createdAt, from, to),
	];

	if (spaceVideoIds && spaceVideoIds.length > 0) {
		conditions.push(
			sql`${videos.id} in (select value from json_each(${JSON.stringify(spaceVideoIds)}))`,
		);
	}

	const rows = await db()
		.select({ bucket: bucketExpr, count: sql<number>`COUNT(*)` })
		.from(videos)
		.where(and(...conditions))
		.groupBy(bucketExpr);

	return rows
		.map((row) => ({
			bucket: normalizeBucket(row.bucket, bucket),
			count: Number(row.count) || 0,
		}))
		.filter((row): row is CountSeriesRow => Boolean(row.bucket));
};

const queryCommentsSeries = async (
	orgId: OrgId,
	from: Date,
	to: Date,
	type: "text" | "emoji",
	bucket: "hour" | "day",
	spaceVideoIds?: VideoId[],
): Promise<CountSeriesRow[]> => {
	const column = comments.createdAt;
	const bucketExpr =
		bucket === "hour"
			? sql<string>`strftime('%Y-%m-%dT%H:00:00Z', ${column} / 1000, 'unixepoch')`
			: sql<string>`strftime('%Y-%m-%dT00:00:00Z', ${column} / 1000, 'unixepoch')`;

	const conditions = [
		eq(videos.orgId, orgId),
		eq(comments.type, type),
		between(comments.createdAt, from, to),
	];

	if (spaceVideoIds && spaceVideoIds.length > 0) {
		conditions.push(
			sql`${videos.id} in (select value from json_each(${JSON.stringify(spaceVideoIds)}))`,
		);
	}

	const rows = await db()
		.select({ bucket: bucketExpr, count: sql<number>`COUNT(*)` })
		.from(comments)
		.innerJoin(videos, eq(comments.videoId, videos.id))
		.where(and(...conditions))
		.groupBy(bucketExpr);

	return rows
		.map((row) => ({
			bucket: normalizeBucket(row.bucket, bucket),
			count: Number(row.count) || 0,
		}))
		.filter((row): row is CountSeriesRow => Boolean(row.bucket));
};
