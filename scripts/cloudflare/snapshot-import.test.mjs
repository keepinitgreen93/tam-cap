import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import {
	compareSnapshots,
	pollSnapshot,
	snapshotFailureDiagnostic,
} from "./backup-restore-drill.mjs";
import { projectSnapshot, snapshotLiteral } from "./snapshot-import.mjs";

const tricky =
	"quoted; CREATE TABLE fake(x);\nline 'quote' -- not a comment\u0000tail";
function exportFixture() {
	return `PRAGMA defer_foreign_keys=ON;
CREATE TABLE child(id INTEGER PRIMARY KEY,parent_id INTEGER REFERENCES parent(id),payload TEXT,bytes BLOB,size INTEGER GENERATED ALWAYS AS(length(payload)) STORED);
INSERT INTO child(id,parent_id,payload,bytes) VALUES(1,1,${snapshotLiteral(tricky)},X'00ff');
CREATE TABLE parent(id INTEGER PRIMARY KEY);
INSERT INTO parent VALUES(1);
CREATE TABLE audit(message TEXT);
INSERT INTO audit VALUES('existing; CREATE TABLE text');
CREATE UNIQUE INDEX child_parent ON child(parent_id);
CREATE VIEW child_view AS SELECT id,payload FROM child;
CREATE TRIGGER child_audit AFTER INSERT ON child BEGIN
INSERT INTO audit VALUES(CASE WHEN NEW.payload LIKE '%CREATE TABLE%' THEN 'CREATE TABLE text; still data' ELSE 'ordinary; text' END);
SELECT CASE WHEN NEW.parent_id < 0 THEN RAISE(ABORT,'bad; parent') ELSE 1 END;
END;`;
}
test("authoritative schema projection restores child-first exports with constraints and exact complex data", () => {
	const sql = exportFixture();
	const bad = new DatabaseSync(":memory:", {
		enableForeignKeyConstraints: true,
	});
	assert.throws(() => bad.exec(sql), /no such table/);
	bad.close();
	const projection = projectSnapshot(sql);
	assert.deepEqual(compareSnapshots(sql, projection.sql), {
		schemaMatches: true,
		rowsMatch: true,
	});
	const database = new DatabaseSync(":memory:", {
		enableForeignKeyConstraints: true,
	});
	try {
		for (const statement of projection.statements) database.exec(statement);
		assert.equal(
			database.prepare("SELECT payload FROM child").get().payload,
			tricky,
		);
		assert.deepEqual(
			[...database.prepare("SELECT bytes FROM child").get().bytes],
			[0, 255],
		);
		assert.equal(
			database.prepare("SELECT count(*) AS n FROM audit").get().n,
			1,
		);
		assert.equal(
			database.prepare("SELECT payload FROM child_view").get().payload,
			tricky,
		);
		assert.equal(database.prepare("PRAGMA foreign_key_check").all().length, 0);
		database.exec(
			"INSERT INTO parent VALUES(2); INSERT INTO child(id,parent_id,payload) VALUES(2,2,'CREATE TABLE marker; data');",
		);
		assert.equal(
			database.prepare("SELECT count(*) AS n FROM audit").get().n,
			2,
		);
		assert.throws(
			() => database.exec("INSERT INTO child(id,parent_id) VALUES(3,99)"),
			/FOREIGN KEY/,
		);
	} finally {
		database.close();
	}
});
test("invalid foreign keys and cyclic restore dependencies fail before a remote mutation", () => {
	assert.throws(
		() =>
			projectSnapshot(
				"CREATE TABLE p(id INTEGER PRIMARY KEY); CREATE TABLE c(id INTEGER REFERENCES p(id)); INSERT INTO c VALUES(9);",
			),
		/integrity/,
	);
	assert.throws(
		() =>
			projectSnapshot(
				"CREATE TABLE a(id INTEGER PRIMARY KEY,b INTEGER REFERENCES b(id)); CREATE TABLE b(id INTEGER PRIMARY KEY,a INTEGER REFERENCES a(id)); INSERT INTO a VALUES(1,1); INSERT INTO b VALUES(1,1);",
			),
		/Cyclic/,
	);
});
test("poll diagnostics preserve provider categories without leaking SQL or private values", async () => {
	const payload = {
		status: "error",
		success: false,
		at_bookmark: "bookmark",
		errors: [
			"no such table: main.videos; INSERT INTO private VALUES('secret')",
		],
	};
	const diagnostic = snapshotFailureDiagnostic(payload);
	assert.equal(diagnostic.category, "missing_table");
	assert(!JSON.stringify(diagnostic).includes("secret"));
	assert(!JSON.stringify(diagnostic).includes("INSERT"));
	await assert.rejects(
		pollSnapshot(async () => payload, undefined, 0),
		(error) =>
			error.diagnostic.category === "missing_table" &&
			!error.message.includes("secret"),
	);
	assert.equal(
		snapshotFailureDiagnostic({ success: false, error: '{"D1_RESET_DO":true}' })
			.category,
		"durable_object_reset",
	);
	let attempts = 0;
	assert.deepEqual(
		await pollSnapshot(
			async (bookmark) => {
				attempts++;
				return bookmark
					? { status: "complete", success: true }
					: { status: "active", success: true, at_bookmark: "one" };
			},
			undefined,
			0,
		),
		{ status: "complete", success: true },
	);
	assert.equal(attempts, 2);
});
