import { readFile } from "node:fs/promises";
import { Miniflare } from "miniflare";
import { createAnalyticsDatabase } from "./index.ts";

export async function createAnalyticsTestDatabase() {
	const runtime = new Miniflare({
		modules: true,
		script: "export default { fetch() { return new Response('test'); } }",
		compatibilityDate: "2025-02-04",
		d1Databases: {
			ANALYTICS: "analytics-fixture",
			METADATA: "metadata-isolation-fixture",
		},
	});
	try {
		const binding = await runtime.getD1Database("ANALYTICS");
		const journal = JSON.parse(
			await readFile(
				new URL("./migrations/meta/_journal.json", import.meta.url),
				"utf8",
			),
		) as { entries: { tag: string }[] };
		for (const entry of journal.entries) {
			const migration = await readFile(
				new URL(`./migrations/${entry.tag}.sql`, import.meta.url),
				"utf8",
			);
			for (const statement of migration.split("--> statement-breakpoint"))
				if (statement.trim()) await binding.prepare(statement).run();
		}
		return {
			database: createAnalyticsDatabase(binding),
			binding,
			metadataBinding: await runtime.getD1Database("METADATA"),
			dispose: () => runtime.dispose(),
		};
	} catch (error) {
		await runtime.dispose();
		throw error;
	}
}
