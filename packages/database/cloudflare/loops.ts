import type { User } from "@cap/web-domain";
import { sql } from "drizzle-orm";
import type { AtomicStatement } from "./atomic.ts";
import type { CloudflareDatabase } from "./index.ts";
import { loopsSyncJobs } from "./schema.ts";

export function loopsSyncStatements(
	database: CloudflareDatabase,
	userId: User.UserId,
	teammateJoined = false,
): AtomicStatement[] {
	if (process.env.LOOPS_SYNC_ENABLED !== "true") return [];
	const now = sql`(unixepoch() * 1000)`;
	return [
		database
			.insert(loopsSyncJobs)
			.values({
				userId,
				nextAttemptAt: now,
				...(teammateJoined ? { teammateJoinedAt: now } : {}),
			})
			.onConflictDoUpdate({
				target: loopsSyncJobs.userId,
				set: {
					revision: sql`${loopsSyncJobs.revision} + 1`,
					nextAttemptAt: now,
					failures: 0,
					lastError: null,
					...(teammateJoined ? { teammateJoinedAt: now } : {}),
				},
			}),
	];
}
