import { sql } from "drizzle-orm";
import type { AnySQLiteColumn } from "drizzle-orm/sqlite-core";

export function inJsonArray(
	column: AnySQLiteColumn,
	values: readonly (string | number)[],
) {
	return values.length === 0
		? sql`0`
		: sql`${column} IN (SELECT value FROM json_each(${JSON.stringify(values)}))`;
}

export function jsonExtractString<
	C extends AnySQLiteColumn<{ dataType: "json" }>,
	F extends Extract<keyof NonNullable<C["_"]["data"]>, string>,
>(column: C, field: F) {
	const jsonParam = `$.${field as string}`;
	return sql<string | undefined>`json_extract(${column}, ${jsonParam})`.mapWith(
		(value: unknown) => (typeof value === "string" ? value : undefined),
	);
}
