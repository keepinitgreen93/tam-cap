CREATE TABLE `desktop_sign_in_rate_limits` (
	`windowId` text PRIMARY KEY NOT NULL,
	`requests` integer NOT NULL,
	`expiresAt` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `desktop_sign_in_rate_limits_expires_at_idx` ON `desktop_sign_in_rate_limits` (`expiresAt`);