import { readFile } from "node:fs/promises";
import { Miniflare } from "miniflare";
import { createCloudflareDb } from "./index.ts";

export async function createTestDatabase(
	options: { throughMigration?: number } = {},
) {
	const runtime = new Miniflare({
		modules: true,
		script: "export default { fetch() { return new Response('test'); } }",
		compatibilityDate: "2025-02-04",
		d1Databases: { DB: "cap-fixture" },
	});
	try {
		const binding = await runtime.getD1Database("DB");
		const journal = JSON.parse(
			await readFile(
				new URL("./migrations/meta/_journal.json", import.meta.url),
				"utf8",
			),
		) as { entries: { tag: string }[] };
		for (const [index, entry] of journal.entries.entries()) {
			if (
				options.throughMigration !== undefined &&
				index > options.throughMigration
			)
				break;
			const migration = await readFile(
				new URL(`./migrations/${entry.tag}.sql`, import.meta.url),
				"utf8",
			);
			for (const statement of migration.split("--> statement-breakpoint"))
				if (statement.trim()) await binding.prepare(statement).run();
		}
		return {
			database: createCloudflareDb(binding),
			binding,
			dispose: () => runtime.dispose(),
		};
	} catch (error) {
		await runtime.dispose();
		throw error;
	}
}
