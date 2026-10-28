import assert from "node:assert/strict";
import test from "node:test";
import {
	assertRestoreTarget,
	assertSampleTarget,
	compareSnapshots,
	rowDigest,
	sampleKeys,
} from "./backup-restore-drill.mjs";

const id = "12345678-1234-1234-1234-123456789012";
const name = "tam-cap-restore-drill-12345678123412341234123456789012";
const created = { id, name };
const prefix = `.restore-test/${id}/`;

test("stable digests ignore result order and property order without hiding data changes", () => {
	assert.equal(
		rowDigest([
			{ a: 1, b: "two" },
			{ a: 3, b: null },
		]),
		rowDigest([
			{ b: null, a: 3 },
			{ b: "two", a: 1 },
		]),
	);
	assert.notEqual(rowDigest([{ a: 1 }]), rowDigest([{ a: 2 }]));
	assert.equal(
		rowDigest([{ blob: new Uint8Array([1, 2]) }]),
		rowDigest([{ blob: [1, 2] }]),
	);
});
test("restored snapshot comparison uses exported snapshot instead of a changing live database", () => {
	const sql =
		"CREATE TABLE videos(id TEXT PRIMARY KEY, metadata TEXT); INSERT INTO videos VALUES('clip','{\"state\":\"complete\"}');";
	assert.deepEqual(compareSnapshots(sql, sql), {
		schemaMatches: true,
		rowsMatch: true,
	});
	assert.deepEqual(
		compareSnapshots(sql, `${sql} UPDATE videos SET metadata='newer';`),
		{ schemaMatches: true, rowsMatch: false },
	);
	assert.deepEqual(
		compareSnapshots(sql, `${sql} ALTER TABLE videos ADD COLUMN changed TEXT;`),
		{ schemaMatches: false, rowsMatch: false },
	);
});
test("snapshot foreign key violations fail verification", () => {
	assert.throws(
		() =>
			compareSnapshots(
				"CREATE TABLE parent(id INTEGER PRIMARY KEY); CREATE TABLE child(id INTEGER REFERENCES parent(id)); INSERT INTO child VALUES(2);",
				"",
			),
		/integrity/,
	);
});
test("only the newly created named database can be deleted", () => {
	assert.doesNotThrow(() => assertRestoreTarget(id, name, created));
	for (const [target, targetName, receipt] of [
		["f5069a36-ac6e-4d1e-994e-3ba47e9d4545", name, created],
		[id, "tam-cap-metadata", created],
		[id, name, undefined],
		["different", name, created],
		[undefined, name, { id: undefined, name }],
	]) {
		assert.throws(
			() => assertRestoreTarget(target, targetName, receipt),
			/boundary/,
		);
	}
});
test("sample deletion requires this run prefix and an exact created object receipt", () => {
	const key = `${prefix}raw.mp4`;
	assert.doesNotThrow(() => assertSampleTarget(key, prefix, new Set([key])));
	for (const candidate of [
		"owner/video/raw-upload.mp4",
		`${prefix}../raw.mp4`,
		".restore-test/other/raw.mp4",
	]) {
		assert.throws(
			() => assertSampleTarget(candidate, prefix, new Set([candidate])),
			/boundary/,
		);
	}
	assert.throws(() => assertSampleTarget(key, prefix, new Set()), /boundary/);
});

test("media sampling follows the exported active output pointer after an edit", () => {
	const video = {
		id: "clip",
		ownerId: "owner",
		source: JSON.stringify({
			outputKey: "owner/clip/.recording/edits/new/result.mp4",
		}),
		metadata: JSON.stringify({
			processingRun: { rawFileKey: "owner/clip/raw-upload.mp4" },
		}),
	};
	assert.deepEqual(sampleKeys(video), {
		raw: "owner/clip/raw-upload.mp4",
		derived: "owner/clip/.recording/edits/new/result.mp4",
	});
	assert.throws(
		() =>
			sampleKeys({
				...video,
				source: JSON.stringify({ outputKey: "other/clip/result.mp4" }),
			}),
		/boundary/,
	);
});
