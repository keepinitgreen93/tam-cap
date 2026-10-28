CREATE TABLE `desktop_sign_in_requests` (
	`id` text PRIMARY KEY NOT NULL,
	`codeChallenge` text NOT NULL,
	`userId` text,
	`expiresAt` integer NOT NULL,
	`lastPolledAt` integer
);
--> statement-breakpoint
CREATE INDEX `desktop_sign_in_requests_expires_at_idx` ON `desktop_sign_in_requests` (`expiresAt`);