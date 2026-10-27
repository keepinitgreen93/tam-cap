import type { D1Database } from "@cloudflare/workers-types";
import { sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";
import type { AnySQLiteColumn } from "drizzle-orm/sqlite-core";
import { withExactMutationCounts } from "./mutation-counts.ts";
import * as schema from "./schema.ts";

export const createCloudflareDb = (binding: D1Database) => {
	const database = drizzle(withExactMutationCounts(binding), { schema });
	database.transaction = async () => {
		throw new Error(
			"D1 does not support interactive transactions. Use an atomic batch or a conditional statement.",
		);
	};
	return database;
};

export type CloudflareDatabase = ReturnType<typeof createCloudflareDb>;

export const updateIfDefined = <T>(
	value: T | undefined,
	column: AnySQLiteColumn,
) => sql`coalesce(${value === undefined ? sql`NULL` : value}, ${column})`;
