import { readFile, writeFile } from "node:fs/promises";
import { is } from "drizzle-orm";
import { getTableConfig, SQLiteTable } from "drizzle-orm/sqlite-core";
import * as schema from "./schema.ts";

const tables = Object.values(schema)
	.filter((value) => is(value, SQLiteTable))
	.map((table) => getTableConfig(table).name)
	.sort();
const identifier = (value: string) => `"${value.replaceAll('"', '""')}"`;
const statements = [
	"CREATE TABLE cap_database_revision (id INTEGER PRIMARY KEY CHECK (id = 1), revision INTEGER NOT NULL CHECK (revision >= 0 AND revision < 9007199254740991))",
	"INSERT INTO cap_database_revision (id, revision) VALUES (1, 0)",
	"CREATE TABLE cap_snapshot_guard (id INTEGER PRIMARY KEY CHECK (id = 1), valid INTEGER NOT NULL CONSTRAINT cap_d1_snapshot_guard CHECK (valid = 1))",
	...tables.flatMap((table) =>
		["INSERT", "UPDATE", "DELETE"].map(
			(operation) =>
				`CREATE TRIGGER ${identifier(`cap_revision_${table}_${operation.toLowerCase()}`)} AFTER ${operation} ON ${identifier(table)} BEGIN UPDATE cap_database_revision SET revision = revision + 1 WHERE id = 1; END`,
		),
	),
];
const output = `${statements.join(";\n--> statement-breakpoint\n")};\n`;
const destination = new URL(
	"./migrations/0001_d1_concurrency.sql",
	import.meta.url,
);
if (process.argv.includes("--check")) {
	if ((await readFile(destination, "utf8")).replaceAll("\r\n", "\n") !== output)
		throw new Error(
			"D1 revision migration is out of date; regenerate before deployment.",
		);
} else {
	await writeFile(destination, output);
}
