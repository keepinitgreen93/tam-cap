import { sql } from "drizzle-orm";
import {
	check,
	index,
	integer,
	sqliteTable,
	text,
} from "drizzle-orm/sqlite-core";

export const analyticsEvents = sqliteTable(
	"analytics_events",
	{
		id: text("id").notNull().primaryKey(),
		organizationId: text("organization_id").notNull(),
		videoId: text("video_id").notNull(),
		sessionHash: text("session_hash").notNull(),
		occurredAt: integer("occurred_at", { mode: "timestamp_ms" }).notNull(),
		expiresAt: integer("expires_at", { mode: "timestamp_ms" }).notNull(),
		country: text("country").notNull().default(""),
		region: text("region").notNull().default(""),
		city: text("city").notNull().default(""),
		browser: text("browser").notNull().default("unknown"),
		device: text("device").notNull().default("desktop"),
		os: text("os").notNull().default("unknown"),
	},
	(table) => [
		index("analytics_events_organization_time").on(
			table.organizationId,
			table.occurredAt,
		),
		index("analytics_events_video_time_session").on(
			table.organizationId,
			table.videoId,
			table.occurredAt,
			table.sessionHash,
		),
		index("analytics_events_expiry").on(table.expiresAt),
		check(
			"analytics_events_identity_length",
			sql`length(${table.id}) = 64 and length(${table.sessionHash}) = 64 and length(${table.organizationId}) between 1 and 64 and length(${table.videoId}) between 1 and 64`,
		),
		check(
			"analytics_events_time",
			sql`${table.occurredAt} >= 0 and ${table.expiresAt} > ${table.occurredAt}`,
		),
		check(
			"analytics_events_dimensions_length",
			sql`length(${table.country}) <= 256 and length(${table.region}) <= 256 and length(${table.city}) <= 256 and length(${table.browser}) <= 256 and length(${table.device}) <= 256 and length(${table.os}) <= 256`,
		),
	],
);
