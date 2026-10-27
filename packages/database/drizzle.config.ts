import type { Config } from "drizzle-kit";

if (process.env.CAP_RUNTIME === "cloudflare")
	throw new Error(
		"MySQL tooling is disabled in the Cloudflare environment. Apply reviewed D1 migrations through Wrangler with an explicit database target.",
	);

const URL = process.env.DATABASE_URL;

if (!URL) throw new Error("DATABASE_URL must be set!");
if (!URL?.startsWith("mysql://"))
	throw new Error(
		"DATABASE_URL must be a 'mysql://' URI. Drizzle Kit doesn't support the fetch adapter!",
	);

export default {
	schema: "./legacy/schema.ts",
	out: "./migrations",
	dialect: "mysql",
	dbCredentials: { url: URL },
	casing: "snake_case",
	tablesFilter: ["*", "!cluster_*"],
} satisfies Config;
