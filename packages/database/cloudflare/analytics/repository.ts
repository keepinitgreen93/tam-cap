import { createHash, createHmac } from "node:crypto";
import {
	and,
	asc,
	countDistinct,
	desc,
	eq,
	gte,
	inArray,
	lt,
	lte,
	ne,
	sql,
} from "drizzle-orm";
import { z } from "zod";
import type { AnalyticsDatabase } from "./index.ts";
import { analyticsEvents } from "./schema.ts";

export const ANALYTICS_RETENTION_DAYS = 90;
const retentionMs = ANALYTICS_RETENTION_DAYS * 24 * 60 * 60 * 1000;
const identity = z.string().regex(/^[A-Za-z0-9_-]{1,64}$/);
const dimension = z.string().max(256);
const viewSchema = z.object({
	organizationId: identity,
	videoId: identity,
	sessionId: z.string().min(1).max(128),
	occurredAt: z.date(),
	eventId: z.string().min(1).max(128).optional(),
	country: dimension.default(""),
	region: dimension.default(""),
	city: dimension.default(""),
	browser: dimension.default("unknown"),
	device: dimension.default("desktop"),
	os: dimension.default("unknown"),
});
export type AnalyticsView = z.input<typeof viewSchema>;
export type AnalyticsScope = {
	organizationId: string;
	from: Date;
	to: Date;
	videoIds?: readonly string[];
};
export type AnalyticsDimension =
	| "country"
	| "region"
	| "city"
	| "browser"
	| "device"
	| "os";

function scopeWhere(input: AnalyticsScope, now: Date) {
	identity.parse(input.organizationId);
	if (
		!Number.isFinite(input.from.getTime()) ||
		!Number.isFinite(input.to.getTime()) ||
		input.from > input.to
	)
		throw new Error("Invalid analytics date range");
	if (input.videoIds) {
		if (input.videoIds.length > 10000)
			throw new Error("Too many videos in analytics scope");
		for (const id of input.videoIds) identity.parse(id);
	}
	return and(
		eq(analyticsEvents.organizationId, input.organizationId),
		gte(
			analyticsEvents.occurredAt,
			new Date(Math.max(input.from.getTime(), now.getTime() - retentionMs)),
		),
		lte(analyticsEvents.occurredAt, input.to),
		input.videoIds
			? sql`${analyticsEvents.videoId} in (select value from json_each(${JSON.stringify(input.videoIds)}))`
			: undefined,
	);
}

export function createAnalyticsRepository(
	database: AnalyticsDatabase,
	sessionSecret: string,
) {
	if (!sessionSecret)
		throw new Error("Analytics session hashing is not configured");
	return {
		async recordView(input: AnalyticsView, now = new Date()) {
			const value = viewSchema.parse(input);
			if (
				value.occurredAt.getTime() > now.getTime() + 5 * 60 * 1000 ||
				value.occurredAt.getTime() < now.getTime() - retentionMs
			)
				throw new Error("Analytics event is outside the retained time window");
			const sessionHash = createHmac("sha256", sessionSecret)
				.update(`cap-analytics-session-v1\0${value.sessionId}`)
				.digest("hex");
			const id = createHash("sha256")
				.update(
					JSON.stringify([
						value.organizationId,
						value.videoId,
						sessionHash,
						value.eventId ?? value.occurredAt.toISOString(),
					]),
				)
				.digest("hex");
			const inserted = await database
				.insert(analyticsEvents)
				.values({
					id,
					organizationId: value.organizationId,
					videoId: value.videoId,
					sessionHash,
					occurredAt: value.occurredAt,
					expiresAt: new Date(value.occurredAt.getTime() + retentionMs),
					country: value.country,
					region: value.region,
					city: value.city,
					browser: value.browser,
					device: value.device,
					os: value.os,
				})
				.onConflictDoNothing()
				.returning({ id: analyticsEvents.id });
			return inserted.length === 1;
		},
		async countViews(input: AnalyticsScope, now = new Date()) {
			return database
				.select({
					videoId: analyticsEvents.videoId,
					views: countDistinct(analyticsEvents.sessionHash),
				})
				.from(analyticsEvents)
				.where(scopeWhere(input, now))
				.groupBy(analyticsEvents.videoId);
		},
		async viewSeries(
			input: AnalyticsScope,
			bucket: "hour" | "day",
			now = new Date(),
		) {
			const bucketExpression =
				bucket === "hour"
					? sql<string>`strftime('%Y-%m-%dT%H:00:00Z',${analyticsEvents.occurredAt}/1000,'unixepoch')`
					: sql<string>`strftime('%Y-%m-%dT00:00:00Z',${analyticsEvents.occurredAt}/1000,'unixepoch')`;
			return database
				.select({
					bucket: bucketExpression,
					views: countDistinct(analyticsEvents.sessionHash),
				})
				.from(analyticsEvents)
				.where(scopeWhere(input, now))
				.groupBy(bucketExpression)
				.orderBy(asc(bucketExpression));
		},
		async breakdown(
			input: AnalyticsScope,
			dimension: AnalyticsDimension,
			limit = 10,
			now = new Date(),
		) {
			const columns = {
				country: analyticsEvents.country,
				region: analyticsEvents.region,
				city: analyticsEvents.city,
				browser: analyticsEvents.browser,
				device: analyticsEvents.device,
				os: analyticsEvents.os,
			};
			const column = columns[dimension];
			if (!Object.hasOwn(columns, dimension))
				throw new Error("Unknown analytics dimension");
			const views = countDistinct(analyticsEvents.sessionHash);
			return database
				.select({ name: column, views })
				.from(analyticsEvents)
				.where(
					and(
						scopeWhere(input, now),
						["country", "region", "city"].includes(dimension)
							? ne(column, "")
							: undefined,
					),
				)
				.groupBy(column)
				.orderBy(desc(views), asc(column))
				.limit(Math.min(100, Math.max(1, Math.trunc(limit))));
		},
		async cityBreakdown(input: AnalyticsScope, limit = 10, now = new Date()) {
			const views = countDistinct(analyticsEvents.sessionHash);
			return database
				.select({
					name: analyticsEvents.city,
					country: analyticsEvents.country,

					views,
				})
				.from(analyticsEvents)
				.where(and(scopeWhere(input, now), ne(analyticsEvents.city, "")))
				.groupBy(analyticsEvents.city, analyticsEvents.country)
				.orderBy(desc(views), asc(analyticsEvents.city))
				.limit(Math.min(100, Math.max(1, Math.trunc(limit))));
		},
		async topCaps(input: AnalyticsScope, limit = 10, now = new Date()) {
			const views = countDistinct(analyticsEvents.sessionHash);
			return database
				.select({ videoId: analyticsEvents.videoId, views })
				.from(analyticsEvents)
				.where(scopeWhere(input, now))
				.groupBy(analyticsEvents.videoId)
				.orderBy(desc(views), asc(analyticsEvents.videoId))
				.limit(Math.min(100, Math.max(1, Math.trunc(limit))));
		},
		async cleanup(now = new Date(), maxBatches = 10) {
			let deleted = 0;
			for (
				let batch = 0;
				batch < Math.min(20, Math.max(1, Math.trunc(maxBatches)));
				batch++
			) {
				const result = await database
					.delete(analyticsEvents)
					.where(
						inArray(
							analyticsEvents.id,
							database
								.select({ id: analyticsEvents.id })
								.from(analyticsEvents)
								.where(lt(analyticsEvents.expiresAt, now))
								.limit(1000),
						),
					)
					.returning({ id: analyticsEvents.id });
				deleted += result.length;
				if (result.length < 1000) break;
			}
			return deleted;
		},
		async deleteOrganization(organizationId: string) {
			identity.parse(organizationId);
			await database
				.delete(analyticsEvents)
				.where(eq(analyticsEvents.organizationId, organizationId));
		},
	};
}
