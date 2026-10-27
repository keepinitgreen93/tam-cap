import { sql } from "drizzle-orm";
import { check, integer, sqliteTable } from "drizzle-orm/sqlite-core";

export const databaseRevision = sqliteTable("cap_database_revision", {
	id: integer("id").primaryKey(),
	revision: integer("revision").notNull(),
});

export const snapshotGuard = sqliteTable(
	"cap_snapshot_guard",
	{
		id: integer("id").primaryKey(),
		valid: integer("valid").notNull(),
	},
	(table) => [check("cap_d1_snapshot_guard", sql`${table.valid} = 1`)],
);
