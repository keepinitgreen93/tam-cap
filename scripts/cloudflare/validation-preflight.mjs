import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const configuration = JSON.parse(
	await readFile(
		new URL("../../infra/cloudflare/wrangler.jsonc", import.meta.url),
		"utf8",
	),
);
const database = configuration.d1_databases.find(
	(entry) => entry.binding === "DB",
);
if (database?.database_name !== "tam-cap-metadata")
	throw new Error("Unexpected preflight database");
const run = promisify(execFile);
const cli =
	process.env.CAP_WRANGLER_CLI ??
	join(process.env.APPDATA ?? "", "npm/node_modules/wrangler/bin/wrangler.js");
const configPath = fileURLToPath(
	new URL("../../infra/cloudflare/wrangler.jsonc", import.meta.url),
);
const source = await readFile(
	new URL(
		"../../packages/database/cloudflare/validation-preflight.sql",
		import.meta.url,
	),
	"utf8",
);
const statements = source
	.split(/;\s*(?:\r?\n|$)/)
	.map((statement) => statement.trim())
	.filter(Boolean);
const rows = [];
for (let offset = 0; offset < statements.length; offset += 4) {
	const batches = await Promise.all(
		statements.slice(offset, offset + 4).map(async (sql) => {
			const { stdout } = await run(
				process.execPath,
				[
					cli,
					"d1",
					"execute",
					database.database_name,
					"--remote",
					"--config",
					configPath,
					"--command",
					sql,
					"--json",
				],
				{ timeout: 60000, maxBuffer: 1024 * 1024, windowsHide: true },
			);
			const result = JSON.parse(stdout);
			if (
				!Array.isArray(result) ||
				result.some((query) => !query.success || !Array.isArray(query.results))
			)
				throw new Error("Invalid D1 preflight response");
			return result.flatMap((query) => query.results);
		}),
	);
	rows.push(...batches.flat());
}
if (
	rows.length !== 49 ||
	rows.some(
		(row) => !Number.isSafeInteger(row.invalid_rows) || row.invalid_rows < 0,
	)
)
	throw new Error("Incomplete D1 preflight results");
const invalid = rows.filter((row) => row.invalid_rows > 0);
console.log(
	JSON.stringify({
		database: database.database_name,
		tablesChecked: rows.length,
		invalidTables: invalid,
		checkedAt: new Date().toISOString(),
	}),
);
if (invalid.length) process.exitCode = 2;
