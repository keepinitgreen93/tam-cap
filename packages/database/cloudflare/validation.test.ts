import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { after, before, test } from "node:test";
import { createTestDatabase } from "./test-runtime.ts";

let fixture: Awaited<ReturnType<typeof createTestDatabase>>;

before(async () => {
	fixture = await createTestDatabase();
	await fixture.binding
		.prepare(
			"INSERT INTO users (id, email, activeOrganizationId) VALUES (?, ?, ?)",
		)
		.bind("validation-user", "validation@example.com", "")
		.run();
});
after(async () => fixture?.dispose());

test("validation triggers cover both mutations on all application tables without replacing revision triggers", async () => {
	const validation = await fixture.binding
		.prepare(
			"SELECT COUNT(*) AS count FROM sqlite_master WHERE type = 'trigger' AND name LIKE 'cap_validate_%'",
		)
		.first<number>("count");
	const revisions = await fixture.binding
		.prepare(
			"SELECT COUNT(*) AS count FROM sqlite_master WHERE type = 'trigger' AND name LIKE 'cap_revision_%'",
		)
		.first<number>("count");
	assert.equal(validation, 98);
	assert.equal(revisions, 147);
});

test("varchar bounds count Unicode characters and embedded NUL accurately", async () => {
	const update = (name: string) =>
		fixture.binding
			.prepare("UPDATE users SET name = ? WHERE id = ?")
			.bind(name, "validation-user")
			.run();
	await update("😀".repeat(255));
	await assert.rejects(update("😀".repeat(256)), /cap_validate_users_name/);
	await update(`a\0${"b".repeat(253)}`);
	await assert.rejects(
		update(`a\0${"b".repeat(254)}`),
		/cap_validate_users_name/,
	);
	await assert.rejects(
		update(`\0${"😀".repeat(255)}`),
		/cap_validate_users_name/,
	);
	await update("Valid name");
	await assert.rejects(
		fixture.binding
			.prepare(
				"INSERT INTO users (id, email, activeOrganizationId) VALUES (?, ?, '')",
			)
			.bind("id-longer-than-15", "oversize@example.com")
			.run(),
		/cap_validate_users_id/,
	);
});

test("malformed raw JSON is rejected while SQL null and valid scalar JSON remain valid", async () => {
	const update = (value: string | null) =>
		fixture.binding
			.prepare("UPDATE users SET preferences = ? WHERE id = ?")
			.bind(value, "validation-user")
			.run();
	await assert.rejects(update("{invalid"), /cap_validate_users_preferences/);
	await assert.rejects(
		update("{'json5':true}"),
		/cap_validate_users_preferences/,
	);
	await update(null);
	await update("null");
	await update("42");
	await update('{"notifications":{"pauseViews":true}}');
});

test("integer, safe bigint, boolean, floating-point and date boundaries reject invalid raw writes", async () => {
	await assert.rejects(
		fixture.binding
			.prepare(
				"UPDATE users SET inviteQuota = 2147483648 WHERE id = 'validation-user'",
			)
			.run(),
		/cap_validate_users_inviteQuota/,
	);
	await assert.rejects(
		fixture.binding
			.prepare(
				"UPDATE users SET inviteQuota = 1.5 WHERE id = 'validation-user'",
			)
			.run(),
		/cap_validate_users_inviteQuota/,
	);
	await fixture.binding
		.prepare(
			"UPDATE users SET inviteQuota = -2147483648 WHERE id = 'validation-user'",
		)
		.run();
	await fixture.binding
		.prepare(
			"UPDATE users SET inviteQuota = 2147483647 WHERE id = 'validation-user'",
		)
		.run();
	await assert.rejects(
		fixture.binding
			.prepare(
				"UPDATE users SET emailVerified = 'not-a-date' WHERE id = 'validation-user'",
			)
			.run(),
		/cap_validate_users_emailVerified/,
	);
	await assert.rejects(
		fixture.binding
			.prepare(
				"UPDATE users SET emailVerified = 8640000000000001 WHERE id = 'validation-user'",
			)
			.run(),
		/cap_validate_users_emailVerified/,
	);
	await fixture.binding
		.prepare("UPDATE users SET emailVerified = 0 WHERE id = 'validation-user'")
		.run();
	await fixture.binding
		.prepare(
			"INSERT INTO media_processing_budgets (id, limit_bytes, reserved_bytes, expires_at) VALUES ('validation-budget', 9007199254740991, 0, 0)",
		)
		.run();
	await assert.rejects(
		fixture.binding
			.prepare(
				"UPDATE media_processing_budgets SET limit_bytes = 9007199254740992 WHERE id = 'validation-budget'",
			)
			.run(),
		/cap_validate_media_processing_budgets_limit_bytes/,
	);
	await assert.rejects(
		fixture.binding
			.prepare(
				"UPDATE media_processing_budgets SET reserved_bytes = -1 WHERE id = 'validation-budget'",
			)
			.run(),
		/cap_validate_media_processing_budgets_reserved_bytes/,
	);
	await fixture.binding
		.prepare(
			"INSERT INTO organizations (id, name, ownerId) VALUES ('validation-org', 'Org', 'validation-user')",
		)
		.run();
	await fixture.binding
		.prepare(
			"INSERT INTO organization_members (id, organizationId, userId, role, hasProSeat) VALUES ('validation-seat', 'validation-org', 'validation-user', 'member', 1)",
		)
		.run();
	await assert.rejects(
		fixture.binding
			.prepare(
				"UPDATE organization_members SET hasProSeat = 2 WHERE id = 'validation-seat'",
			)
			.run(),
		/cap_validate_organization_members_hasProSeat/,
	);
	await fixture.binding
		.prepare(
			"INSERT INTO comments (id, type, content, authorId, videoId, timestamp) VALUES ('validation-msg', 'other', 'Text', 'validation-user', 'video', 1.5)",
		)
		.run();
	await assert.rejects(
		fixture.binding
			.prepare(
				"UPDATE comments SET timestamp = 1e40 WHERE id = 'validation-msg'",
			)
			.run(),
		/cap_validate_comments_timestamp/,
	);
});

test("text byte limits are preserved and varchar type annotations are not promoted to enums", async () => {
	await fixture.binding
		.prepare(
			"INSERT INTO comments (id, type, content, authorId, videoId) VALUES ('text-boundary', 'custom', ?, 'validation-user', 'video')",
		)
		.bind("a".repeat(65_535))
		.run();
	await assert.rejects(
		fixture.binding
			.prepare("UPDATE comments SET content = ? WHERE id = 'text-boundary'")
			.bind("a".repeat(65_536))
			.run(),
		/cap_validate_comments_content/,
	);
	await assert.rejects(
		fixture.binding
			.prepare("UPDATE comments SET content = ? WHERE id = 'text-boundary'")
			.bind("😀".repeat(16_384))
			.run(),
		/cap_validate_comments_content/,
	);
});

test("failed validation rolls back earlier batch changes and their revisions", async () => {
	const previous = await fixture.binding
		.prepare("SELECT name FROM users WHERE id = 'validation-user'")
		.first<string>("name");
	const revision = await fixture.binding
		.prepare("SELECT revision FROM cap_database_revision WHERE id = 1")
		.first<number>("revision");
	await assert.rejects(
		fixture.binding.batch([
			fixture.binding.prepare(
				"UPDATE users SET name = 'Should roll back' WHERE id = 'validation-user'",
			),
			fixture.binding.prepare(
				"UPDATE users SET preferences = 'invalid-json' WHERE id = 'validation-user'",
			),
		]),
		/cap_validate_users_preferences/,
	);
	assert.equal(
		await fixture.binding
			.prepare("SELECT name FROM users WHERE id = 'validation-user'")
			.first("name"),
		previous,
	);
	assert.equal(
		await fixture.binding
			.prepare("SELECT revision FROM cap_database_revision WHERE id = 1")
			.first("revision"),
		revision,
	);
});

test("the generated preflight detects existing invalid rows before constraints are applied", async () => {
	const legacy = await createTestDatabase({ throughMigration: 1 });
	try {
		await legacy.binding
			.prepare(
				"INSERT INTO users (id, email, activeOrganizationId, name, preferences, inviteQuota) VALUES ('invalid-legacy', 'legacy@example.com', '', ?, '{invalid', 2147483648)",
			)
			.bind("x".repeat(256))
			.run();
		const preflight = await readFile(
			new URL("./validation-preflight.sql", import.meta.url),
			"utf8",
		);
		const rows: { table_name: string; invalid_rows: number }[] = [];
		for (const statement of preflight.split(";")) {
			if (!statement.trim()) continue;
			const result = await legacy.binding
				.prepare(statement)
				.all<{ table_name: string; invalid_rows: number }>();
			rows.push(...result.results);
		}
		assert.equal(rows.length, 49);
		assert.deepEqual(
			rows.filter((row) => row.invalid_rows > 0),
			[{ table_name: "users", invalid_rows: 1 }],
		);
	} finally {
		await legacy.dispose();
	}
});
