import { readFile, writeFile } from "node:fs/promises";
import { getTableConfig } from "drizzle-orm/sqlite-core";
import { desktopSignInRateLimits, desktopSignInRequests } from "./schema.ts";

for (const [tableSchema, file] of [
	[desktopSignInRequests, "0004_desktop_sign_in_concurrency.sql"],
	[desktopSignInRateLimits, "0006_desktop_sign_in_rate_concurrency.sql"],
] as const) {
	const table = getTableConfig(tableSchema).name;
	const statements = ["INSERT", "UPDATE", "DELETE"].map(
		(operation) =>
			`CREATE TRIGGER "cap_revision_${table}_${operation.toLowerCase()}" AFTER ${operation} ON "${table}" BEGIN UPDATE cap_database_revision SET revision = revision + 1 WHERE id = 1; END`,
	);
	const output = `${statements.join(";\n--> statement-breakpoint\n")};\n`;
	const destination = new URL(`./migrations/${file}`, import.meta.url);
	if (process.argv.includes("--check")) {
		if (
			(await readFile(destination, "utf8")).replaceAll("\r\n", "\n") !== output
		)
			throw new Error("Desktop sign-in concurrency migration is out of date");
	} else await writeFile(destination, output);
}
