CREATE TABLE `analytics_events` (
	`id` text PRIMARY KEY NOT NULL,
	`organization_id` text NOT NULL,
	`video_id` text NOT NULL,
	`session_hash` text NOT NULL,
	`occurred_at` integer NOT NULL,
	`expires_at` integer NOT NULL,
	`country` text DEFAULT '' NOT NULL,
	`region` text DEFAULT '' NOT NULL,
	`city` text DEFAULT '' NOT NULL,
	`browser` text DEFAULT 'unknown' NOT NULL,
	`device` text DEFAULT 'desktop' NOT NULL,
	`os` text DEFAULT 'unknown' NOT NULL,
	CONSTRAINT "analytics_events_identity_length" CHECK(length("analytics_events"."id") = 64 and length("analytics_events"."session_hash") = 64 and length("analytics_events"."organization_id") between 1 and 64 and length("analytics_events"."video_id") between 1 and 64),
	CONSTRAINT "analytics_events_time" CHECK("analytics_events"."occurred_at" >= 0 and "analytics_events"."expires_at" > "analytics_events"."occurred_at"),
	CONSTRAINT "analytics_events_dimensions_length" CHECK(length("analytics_events"."country") <= 256 and length("analytics_events"."region") <= 256 and length("analytics_events"."city") <= 256 and length("analytics_events"."browser") <= 256 and length("analytics_events"."device") <= 256 and length("analytics_events"."os") <= 256)
);
--> statement-breakpoint
CREATE INDEX `analytics_events_organization_time` ON `analytics_events` (`organization_id`,`occurred_at`);--> statement-breakpoint
CREATE INDEX `analytics_events_video_time_session` ON `analytics_events` (`organization_id`,`video_id`,`occurred_at`,`session_hash`);--> statement-breakpoint
CREATE INDEX `analytics_events_expiry` ON `analytics_events` (`expires_at`);