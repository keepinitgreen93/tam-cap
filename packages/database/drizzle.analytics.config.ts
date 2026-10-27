import { defineConfig } from "drizzle-kit";

export default defineConfig({
	schema: "./cloudflare/analytics/schema.ts",
	out: "./cloudflare/analytics/migrations",
	dialect: "sqlite",
	casing: "snake_case",
});
