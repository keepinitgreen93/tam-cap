import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { after, before, test } from "node:test";
import { eq, is } from "drizzle-orm";
import {
	getTableConfig as getMySqlTableConfig,
	MySqlTable,
} from "drizzle-orm/mysql-core";
import {
	type ForeignKey,
	getTableConfig,
	type Index,
	SQLiteTable,
} from "drizzle-orm/sqlite-core";
import { Miniflare } from "miniflare";
import * as canonicalDatabase from "../index.ts";
import { db as legacyDb } from "../legacy/index.ts";
import * as upstream from "../legacy/schema.ts";
import * as canonicalSchema from "../schema.ts";
import { db as applicationDb } from "./application.ts";
import { createCloudflareDb } from "./index.ts";
import * as schema from "./schema.ts";

const runtime = new Miniflare({
	modules: true,
	script: "export default { fetch() { return new Response('test'); } }",
	compatibilityDate: "2025-02-04",
	d1Databases: { DB: "cap-schema-test" },
});
let binding: Awaited<ReturnType<typeof runtime.getD1Database>>;
let database: ReturnType<typeof createCloudflareDb>;

test("canonical exports use D1 while legacy MySQL cannot connect from Cloudflare", () => {
	assert.equal(canonicalDatabase.db, applicationDb);
	assert.equal(canonicalSchema.videos, schema.videos);
	const previous = process.env.CAP_RUNTIME;
	process.env.CAP_RUNTIME = "cloudflare";
	try {
		assert.throws(() => legacyDb(), /Legacy MySQL persistence is unavailable/);
	} finally {
		if (previous === undefined) delete process.env.CAP_RUNTIME;
		else process.env.CAP_RUNTIME = previous;
	}
});

before(async () => {
	binding = await runtime.getD1Database("DB");
	database = createCloudflareDb(binding);
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
		for (const statement of migration.split("--> statement-breakpoint")) {
			if (statement.trim()) await binding.prepare(statement).run();
		}
	}
});

after(async () => {
	await runtime.dispose();
});

test("every upstream table preserves its columns, application types, keys and indexes", async () => {
	const mysqlTables = Object.values(upstream).filter((value) =>
		is(value, MySqlTable),
	);
	const sqliteTables = Object.values(schema).filter(
		(value) =>
			is(value, SQLiteTable) &&
			value !== schema.desktopSignInRequests &&
			value !== schema.desktopSignInRateLimits,
	);
	assert.equal(sqliteTables.length, mysqlTables.length);
	assert.equal(sqliteTables.length, 49);
	const actualTables = await binding
		.prepare("SELECT name FROM sqlite_master WHERE type = 'table'")
		.all<{ name: string }>();
	for (const mysqlTable of mysqlTables) {
		const original = getMySqlTableConfig(mysqlTable);
		const converted = sqliteTables
			.map(getTableConfig)
			.find((table) => table.name === original.name);
		assert.ok(converted, original.name);
		assert.ok(
			actualTables.results.some((table) => table.name === original.name),
			original.name,
		);
		const shape = (
			column:
				| (typeof original.columns)[number]
				| (typeof converted.columns)[number],
		) => ({
			name: column.name,
			dataType:
				column.getSQLType() === "text COLLATE NOCASE"
					? "string"
					: column.dataType,
			notNull: column.notNull,
			primary: column.primary,
			isUnique: column.isUnique,
			hasDefault: column.hasDefault,
			generated: Boolean(column.generated),
		});
		assert.deepEqual(
			converted.columns.map(shape),
			original.columns.map(shape),
			original.name,
		);
		assert.equal(
			converted.indexes.length,
			original.indexes.length,
			`${original.name} indexes`,
		);
		for (const [index, upstreamIndex] of original.indexes.entries()) {
			const portedIndex: Index | undefined = converted.indexes[index];
			assert.ok(portedIndex);
			assert.equal(portedIndex.config.unique, upstreamIndex.config.unique);
			assert.equal(
				portedIndex.config.name,
				`${original.name}_${upstreamIndex.config.name}`,
			);
			assert.deepEqual(
				portedIndex.config.columns.map((column) =>
					"name" in column ? column.name : "expression",
				),
				upstreamIndex.config.columns.map((column) =>
					"name" in column ? column.name : "objectKey",
				),
			);
		}
		assert.equal(
			converted.uniqueConstraints.length,
			original.uniqueConstraints.length,
			`${original.name} unique constraints`,
		);
		assert.equal(
			converted.primaryKeys.length,
			original.primaryKeys.length,
			`${original.name} primary keys`,
		);
		assert.equal(
			converted.foreignKeys.length,
			original.foreignKeys.length,
			`${original.name} foreign keys`,
		);
		for (const [index, foreignKey] of original.foreignKeys.entries()) {
			const target: ForeignKey | undefined = converted.foreignKeys[index];
			assert.ok(target);
			assert.deepEqual(
				target.reference().columns.map((column) => column.name),
				foreignKey.reference().columns.map((column) => column.name),
			);
			assert.deepEqual(
				target.reference().foreignColumns.map((column) => column.name),
				foreignKey.reference().foreignColumns.map((column) => column.name),
			);
			assert.equal(
				target.onDelete ?? "no action",
				foreignKey.onDelete ?? "no action",
			);
		}
	}
});

test("dates, JSON and nullable values round-trip through the D1 adapter", async () => {
	const verifiedAt = new Date("2026-10-27T12:34:56.789Z");
	const user = {
		id: "date-user" as typeof schema.users.$inferInsert.id,
		activeOrganizationId:
			"test-org" as typeof schema.users.$inferInsert.activeOrganizationId,
		email: "d1-test@example.invalid",
		emailVerified: verifiedAt,
		onboardingSteps: { welcome: true, organizationSetup: false },
	};
	await database.insert(schema.users).values(user);
	const found = await database
		.select()
		.from(schema.users)
		.where(eq(schema.users.id, user.id))
		.get();
	assert.ok(found);
	assert.equal(found.emailVerified?.getTime(), verifiedAt.getTime());
	assert.deepEqual(found.onboardingSteps, user.onboardingSteps);
	assert.equal(found.name, null);
	assert.ok(found.created_at instanceof Date);
	const raw = await binding
		.prepare("SELECT emailVerified, onboardingSteps FROM users WHERE id = ?")
		.bind(user.id)
		.first<{ emailVerified: number; onboardingSteps: string }>();
	assert.equal(raw?.emailVerified, verifiedAt.getTime());
	assert.equal(typeof raw?.onboardingSteps, "string");
	await database
		.update(schema.users)
		.set({ name: "Updated", updated_at: new Date(0) })
		.where(eq(schema.users.id, user.id));
	await database
		.update(schema.users)
		.set({ name: "Updated again" })
		.where(eq(schema.users.id, user.id));
	const updated = await database
		.select()
		.from(schema.users)
		.where(eq(schema.users.id, user.id))
		.get();
	assert.ok(updated && updated.updated_at.getTime() > 0);
});

test("generated creation date retains millisecond metadata dates and invalid-date fallback", async () => {
	const createdAt = new Date("2026-10-26T01:02:03.456Z");
	for (const [id, metadata, expected] of [
		[
			"custom-date",
			{ customCreatedAt: "2025-02-03T04:05:06.789Z" },
			Date.parse("2025-02-03T04:05:06.789Z"),
		],
		[
			"whole-date",
			{ customCreatedAt: "2025-02-03T04:05:06Z" },
			Date.parse("2025-02-03T04:05:06Z"),
		],
		["invalid-date", { customCreatedAt: "invalid" }, createdAt.getTime()],
		["missing-date", {}, createdAt.getTime()],
	] as const) {
		await database.insert(schema.videos).values({
			id: id as typeof schema.videos.$inferInsert.id,
			ownerId: "owner" as typeof schema.videos.$inferInsert.ownerId,
			orgId: "test-org" as typeof schema.videos.$inferInsert.orgId,
			name: "Date test",
			createdAt,
			metadata,
		});
		const video = await database
			.select()
			.from(schema.videos)
			.where(eq(schema.videos.id, id as typeof schema.videos.$inferSelect.id))
			.get();
		assert.equal(video?.effectiveCreatedAt?.getTime(), expected, id);
		assert.equal(video?.isScreenshot, false);
		assert.deepEqual(video?.source, { type: "MediaConvert" });
	}
});

test("unique and composite keys reject duplicates while nullable unique fields allow null", async () => {
	await assert.rejects(
		binding
			.prepare("INSERT INTO users (id, email) VALUES (?, ?)")
			.bind("duplicate", "d1-test@example.invalid")
			.run(),
		/UNIQUE/,
	);
	await binding
		.prepare(
			"INSERT INTO imported_videos (id, orgId, source, source_id) VALUES (?, ?, ?, ?)",
		)
		.bind("import-one", "org-one", "loom", "loom-one")
		.run();
	await assert.rejects(
		binding
			.prepare(
				"INSERT INTO imported_videos (id, orgId, source, source_id) VALUES (?, ?, ?, ?)",
			)
			.bind("import-two", "org-one", "loom", "loom-one")
			.run(),
		/UNIQUE/,
	);
	await binding.batch(
		["request-one", "request-two"].map((id) =>
			binding
				.prepare(
					"INSERT INTO loom_migration_requests (id, organizationId, requestedByUserId, createdAt, updatedAt) VALUES (?, ?, ?, ?, ?)",
				)
				.bind(id, "org-one", "owner", 0, 0),
		),
	);
	await binding
		.prepare(
			"UPDATE loom_migration_requests SET activeOrganizationId = ? WHERE id = ?",
		)
		.bind("org-one", "request-one")
		.run();
	await assert.rejects(
		binding
			.prepare(
				"UPDATE loom_migration_requests SET activeOrganizationId = ? WHERE id = ?",
			)
			.bind("org-one", "request-two")
			.run(),
		/UNIQUE/,
	);
});

test("D1 foreign keys reject missing parents and cascade child deletion", async () => {
	await assert.rejects(
		binding
			.prepare(
				"INSERT INTO video_edits (sourceKey, videoId, editSpec) VALUES (?, ?, ?)",
			)
			.bind("edit-missing", "missing", "{}")
			.run(),
		/FOREIGN KEY/,
	);
	await binding
		.prepare(
			"INSERT INTO video_edits (sourceKey, videoId, editSpec) VALUES (?, ?, ?)",
		)
		.bind("edit-existing", "custom-date", "{}")
		.run();
	await binding
		.prepare("DELETE FROM videos WHERE id = ?")
		.bind("custom-date")
		.run();
	const edit = await binding
		.prepare("SELECT videoId FROM video_edits WHERE sourceKey = ?")
		.bind("edit-existing")
		.first();
	assert.equal(edit, null);
});

test("D1 batch rolls back all writes on failure and rejects interactive transactions", async () => {
	await assert.rejects(
		database.batch([
			database.insert(schema.users).values({
				id: "batch-one" as typeof schema.users.$inferInsert.id,
				activeOrganizationId:
					"test-org" as typeof schema.users.$inferInsert.activeOrganizationId,
				email: "batch@example.invalid",
			}),
			database.insert(schema.users).values({
				id: "batch-two" as typeof schema.users.$inferInsert.id,
				activeOrganizationId:
					"test-org" as typeof schema.users.$inferInsert.activeOrganizationId,
				email: "batch@example.invalid",
			}),
		]),
		/UNIQUE/,
	);
	assert.equal(
		await binding
			.prepare("SELECT id FROM users WHERE id = ?")
			.bind("batch-one")
			.first(),
		null,
	);
	let callbackInvoked = false;
	await assert.rejects(
		database.transaction(async () => {
			callbackInvoked = true;
		}),
		/interactive transactions/,
	);
	assert.equal(callbackInvoked, false);
});

test("email lookup and unique constraints ignore ASCII case", async () => {
	await assert.rejects(
		binding
			.prepare("INSERT INTO users (id, email) VALUES (?, ?)")
			.bind("case-duplicate", "D1-TEST@EXAMPLE.INVALID")
			.run(),
		/UNIQUE/,
	);
	const user = await database
		.select()
		.from(schema.users)
		.where(eq(schema.users.email, "D1-TEST@EXAMPLE.INVALID"))
		.get();
	assert.equal(user?.email, "d1-test@example.invalid");
	await binding
		.prepare(
			"INSERT INTO video_viewer_grants (id, videoId, email, invitedByUserId) VALUES (?, ?, ?, 'owner')",
		)
		.bind("viewer-one", "whole-date", "Viewer@Example.invalid")
		.run();
	await assert.rejects(
		binding
			.prepare(
				"INSERT INTO video_viewer_grants (id, videoId, email, invitedByUserId) VALUES (?, ?, ?, 'owner')",
			)
			.bind("viewer-two", "whole-date", "viewer@example.invalid")
			.run(),
		/UNIQUE/,
	);
});

test("unsigned byte counters reject negative numbers and preserve large safe integers", async () => {
	await assert.rejects(
		binding
			.prepare(
				"INSERT INTO video_uploads (video_id, uploaded, total) VALUES (?, ?, ?)",
			)
			.bind("negative-upload", -1, 0)
			.run(),
		/CHECK/,
	);
	const uploaded = 2 ** 40;
	await database.insert(schema.videoUploads).values({
		videoId: "large-upload" as typeof schema.videoUploads.$inferInsert.videoId,
		uploaded,
		total: uploaded + 1,
	});
	const result = await database
		.select()
		.from(schema.videoUploads)
		.where(
			eq(
				schema.videoUploads.videoId,
				"large-upload" as typeof schema.videoUploads.$inferSelect.videoId,
			),
		)
		.get();
	assert.equal(result?.uploaded, uploaded);
	assert.equal(result?.total, uploaded + 1);
});
