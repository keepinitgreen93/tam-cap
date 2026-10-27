import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../../", import.meta.url));
const paths = execFileSync(
	"git",
	[
		"ls-files",
		"--cached",
		"--others",
		"--exclude-standard",
		"--",
		"apps",
		"packages",
	],
	{ cwd: root, encoding: "utf8" },
)
	.split(/\r?\n/)
	.filter((path) => /\.[cm]?[jt]sx?$/.test(path))
	.filter(
		(path) =>
			!/(?:__tests__|\/test\/|\.test\.|\.spec\.|\.d\.ts$|\/cloudflare\/|\/migrations\/|\/dist\/|\/\.next\/|\/node_modules\/)/.test(
				path,
			),
	);

const patterns = {
	databaseImports:
		/(?:from\s*["']@cap\/database(?:\/[^"']*)?["']|import\(["']@cap\/database(?:\/[^"']*)?["']\))/,
	mysqlImports:
		/["'](?:drizzle-orm\/(?:mysql-core|mysql2|planetscale-serverless)|mysql2(?:\/[^"']*)?|@effect\/sql-mysql2|@planetscale\/database)["']/,
	interactiveTransactions: /\.transaction\s*\(/,
	mysqlUpserts: /\.onDuplicateKeyUpdate\s*\(/,
	mysqlMutationResults: /\b(?:affectedRows|insertId|changedRows)\b/,
	rowLocks: /\.for\s*\(\s*["']update["']|\bFOR UPDATE\b/i,
	sqlDialectCandidates:
		/(?<![.\w])(?:NOW|DATE_SUB|DATE_ADD|DATE_FORMAT|UNIX_TIMESTAMP|FROM_UNIXTIME|TIMESTAMPDIFF|STR_TO_DATE|JSON_EXTRACT|JSON_UNQUOTE|JSON_CONTAINS|JSON_OBJECT|JSON_ARRAYAGG|GROUP_CONCAT|CONCAT|GREATEST|LEAST|IFNULL|UTC_TIMESTAMP)\s*\(|\bON DUPLICATE KEY\b|\bINTERVAL\s+\d+/i,
};

const findings = Object.fromEntries(
	Object.keys(patterns).map((category) => [category, []]),
);
for (const path of paths) {
	const lines = readFileSync(
		new URL(path, new URL("../../", import.meta.url)),
		"utf8",
	).split(/\r?\n/);
	for (const [index, line] of lines.entries()) {
		for (const [category, pattern] of Object.entries(patterns)) {
			if (pattern.test(line))
				findings[category].push({ path, line: index + 1 });
		}
	}
}

console.log(
	JSON.stringify(
		{
			scope:
				"Non-test TypeScript and JavaScript in apps and packages; line-based candidates require semantic review.",
			sourceFiles: paths.length,
			summary: Object.fromEntries(
				Object.entries(findings).map(([category, matches]) => [
					category,
					{
						lines: matches.length,
						files: new Set(matches.map((match) => match.path)).size,
					},
				]),
			),
			findings,
		},
		null,
		"\t",
	),
);
