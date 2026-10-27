import type { D1Database } from "@cloudflare/workers-types";
import { drizzle } from "drizzle-orm/d1";
import * as schema from "./schema.ts";

export function createAnalyticsDatabase(binding: D1Database) {
	const database = drizzle(binding, { schema });
	database.transaction = async () => {
		throw new Error(
			"Analytics mutations must use single statements or atomic batches.",
		);
	};
	return database;
}

export type AnalyticsDatabase = ReturnType<typeof createAnalyticsDatabase>;
