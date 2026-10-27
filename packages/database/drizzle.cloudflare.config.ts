import { defineConfig } from "drizzle-kit";

export default defineConfig({
	schema: "./cloudflare/schema.ts",
	out: "./cloudflare/migrations",
	dialect: "sqlite",
	casing: "snake_case",
});
