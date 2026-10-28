import { spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const account = "c1e96a4b36c73f3cf4ddf50a90082d94";
const sourceDatabase = "f5069a36-ac6e-4d1e-994e-3ba47e9d4545";
const sourceBucket = "tam-cap-videos";
const apiRoot = `https://api.cloudflare.com/client/v4/accounts/${account}`;
const schemaSql =
	"SELECT type,name,tbl_name,sql FROM sqlite_master WHERE name NOT LIKE 'sqlite_%' AND name NOT LIKE '_cf_%' ORDER BY type,name";

function canonical(value) {
	if (ArrayBuffer.isView(value))
		return Array.from(
			new Uint8Array(value.buffer, value.byteOffset, value.byteLength),
		);
	if (Array.isArray(value)) return value.map(canonical);
	if (value && typeof value === "object")
		return Object.fromEntries(
			Object.keys(value)
				.sort()
				.map((key) => [key, canonical(value[key])]),
		);
	return value;
}
export function rowDigest(rows) {
	return createHash("sha256")
		.update(
			rows
				.map((row) => JSON.stringify(canonical(row)))
				.sort()
				.join("\n"),
		)
		.digest("hex");
}
function schemaDigest(rows) {
	return rowDigest(
		rows.map((row) => ({
			...row,
			sql:
				typeof row.sql === "string"
					? row.sql.replace(/\s+/g, " ").trim()
					: row.sql,
		})),
	);
}
export function assertRestoreTarget(id, name, created) {
	if (
		!created ||
		!/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(id) ||
		id !== created.id ||
		name !== created.name ||
		id === sourceDatabase ||
		!/^tam-cap-restore-drill-[a-f0-9]{32}$/.test(name)
	)
		throw Error("Restore database cleanup boundary rejected");
}
export function assertSampleTarget(key, prefix, createdKeys) {
	if (
		!/^\.restore-test\/[a-f0-9-]{36}\/$/.test(prefix) ||
		!key.startsWith(prefix) ||
		!createdKeys.has(key) ||
		key.includes("..")
	)
		throw Error("Restore sample cleanup boundary rejected");
}
function snapshot(sql) {
	const database = new DatabaseSync(":memory:", {
		enableForeignKeyConstraints: false,
	});
	try {
		database.exec(sql);
		const schema = database.prepare(schemaSql).all();
		const tables = schema
			.filter((row) => row.type === "table")
			.map((row) => row.name);
		const rows = new Map(
			tables.map((name) => [
				name,
				database.prepare(`SELECT * FROM "${name.replaceAll('"', '""')}"`).all(),
			]),
		);
		const quickCheck = database.prepare("PRAGMA quick_check").all();
		const foreignKeys = database.prepare("PRAGMA foreign_key_check").all();
		if (
			!quickCheck.every((row) => row.quick_check === "ok") ||
			foreignKeys.length
		)
			throw Error("Snapshot integrity failed");
		return { schema, tables, rows };
	} finally {
		database.close();
	}
}
export function compareSnapshots(expectedSql, actualSql) {
	const expected = snapshot(expectedSql);
	const actual = snapshot(actualSql);
	return {
		schemaMatches:
			schemaDigest(expected.schema) === schemaDigest(actual.schema),
		rowsMatch: expected.tables.every(
			(name) =>
				actual.rows.has(name) &&
				rowDigest(expected.rows.get(name)) === rowDigest(actual.rows.get(name)),
		),
	};
}
async function protectSnapshot(operation, path, sql = "") {
	return await new Promise((resolvePromise, reject) => {
		const process = spawn(
			"pwsh",
			[
				"-NoProfile",
				"-NonInteractive",
				"-File",
				join(root, "scripts/cloudflare/metadata-snapshot.ps1"),
				"-Operation",
				operation,
				"-Path",
				path,
			],
			{ windowsHide: true, stdio: ["pipe", "pipe", "pipe"] },
		);
		const output = [];
		process.stdout.on("data", (bytes) => output.push(bytes));
		process.stderr.resume();
		process.stdin.on("error", () =>
			reject(Error("Protected snapshot input failed")),
		);
		process.on("error", () =>
			reject(Error("Protected snapshot helper failed")),
		);
		process.on("close", (code) =>
			code === 0
				? resolvePromise(Buffer.concat(output).toString("utf8"))
				: reject(Error("Protected snapshot helper failed")),
		);
		process.stdin.end(sql);
	});
}
async function api(
	token,
	path,
	body,
	method = body === undefined ? "GET" : "POST",
) {
	let response;
	try {
		response = await fetch(`${apiRoot}${path}`, {
			method,
			headers: {
				Authorization: `Bearer ${token}`,
				...(body === undefined ? {} : { "Content-Type": "application/json" }),
			},
			body: body === undefined ? undefined : JSON.stringify(body),
			redirect: "error",
			signal: AbortSignal.timeout(120_000),
		});
	} catch {
		throw Error("Cloudflare API transport failed");
	}
	if (!response.ok) {
		await response.body?.cancel();
		throw Error(`Cloudflare API HTTP ${response.status}`);
	}
	const value = await response.json();
	if (!value.success) throw Error("Cloudflare API operation rejected");
	return value.result;
}
async function poll(operation) {
	let value = await operation();
	for (let attempt = 0; value.status !== "complete"; attempt++) {
		if (value.status === "error" || attempt >= 120 || !value.at_bookmark)
			throw Error("D1 snapshot operation did not complete");
		await new Promise((resolvePromise) => setTimeout(resolvePromise, 1000));
		value = await operation(value.at_bookmark);
	}
	return value;
}
function signedUrl(value) {
	const url = new URL(value);
	if (
		url.protocol !== "https:" ||
		!url.hostname.endsWith(".r2.cloudflarestorage.com")
	)
		throw Error("Unexpected D1 snapshot transfer origin");
	return url;
}
async function transfer(url, options) {
	const response = await fetch(url, {
		...options,
		redirect: "error",
		signal: AbortSignal.timeout(120_000),
	});
	if (!response.ok) {
		await response.body?.cancel();
		throw Error(`Snapshot transfer HTTP ${response.status}`);
	}
	return response;
}
async function object(token, key, method = "GET", bytes) {
	const path = `/r2/buckets/${sourceBucket}/objects/${key.split("/").map(encodeURIComponent).join("/")}`;
	const response = await fetch(`${apiRoot}${path}`, {
		method,
		headers: {
			Authorization: `Bearer ${token}`,
			...(bytes ? { "Content-Type": "application/octet-stream" } : {}),
		},
		body: bytes,
		redirect: "error",
		signal: AbortSignal.timeout(120_000),
	});
	if (!response.ok) {
		await response.body?.cancel();
		throw Error(`R2 sample ${method} HTTP ${response.status}`);
	}
	return response;
}

async function verifyAbsent(token, path) {
	const response = await fetch(`${apiRoot}${path}`, {
		headers: { Authorization: `Bearer ${token}` },
		redirect: "error",
		signal: AbortSignal.timeout(30_000),
	});
	await response.body?.cancel();
	if (response.status !== 404)
		throw Error("Restore resource deletion could not be confirmed");
}
export function sampleKeys(video) {
	const source =
		typeof video.source === "string" ? JSON.parse(video.source) : video.source;
	const metadata =
		typeof video.metadata === "string"
			? JSON.parse(video.metadata)
			: video.metadata;
	const prefix = `${video.ownerId}/${video.id}/`;
	const raw = metadata?.processingRun?.rawFileKey ?? `${prefix}raw-upload.mp4`;
	const derived = source?.outputKey ?? `${prefix}result.mp4`;
	if (
		![raw, derived].every(
			(key) =>
				typeof key === "string" &&
				key.startsWith(prefix) &&
				key.endsWith(".mp4") &&
				!key.includes(".."),
		)
	)
		throw Error("Sample media identity boundary rejected");
	return { raw, derived };
}

export async function runDrill(sampleVideo, snapshotPath) {
	if (process.platform !== "win32")
		throw Error("This protected snapshot drill requires Windows DPAPI");
	if (!/^[a-z0-9]{15}$/.test(sampleVideo))
		throw Error("Supply one authorized synthetic video ID");
	const configuration = await readFile(
		join(homedir(), ".wrangler/config/default.toml"),
		"utf8",
	);
	const token = /^oauth_token\s*=\s*"([^"]+)"/m.exec(configuration)?.[1];
	if (!token)
		throw Error("Authenticated Wrangler OAuth credential unavailable");
	const id = randomUUID();
	const directory = join(root, ".secrets/backups", id);
	await mkdir(directory, { recursive: true });
	const reportPath = join(directory, "report.json");
	const report = {
		id,
		startedAt: new Date().toISOString(),
		sourceDatabase,
		sourceBucket,
		snapshotProtected: false,
		verified: false,
		databaseDeleted: false,
		samplesDeleted: false,
	};
	let created;
	const createdKeys = new Set();
	try {
		let sql;
		if (snapshotPath) {
			sql = await protectSnapshot("Unprotect", resolve(snapshotPath));
		} else {
			const exported = await poll((bookmark) =>
				api(token, `/d1/database/${sourceDatabase}/export`, {
					output_format: "polling",
					...(bookmark ? { current_bookmark: bookmark } : {}),
				}),
			);
			const response = await transfer(signedUrl(exported.result.signed_url));
			sql = await response.text();
		}
		const backupPath = join(directory, "metadata.sql.dpapi");
		await protectSnapshot("Protect", backupPath, sql);
		const recovered = await protectSnapshot("Unprotect", backupPath);
		if (recovered !== sql) throw Error("Protected snapshot round trip failed");
		report.snapshotProtected = true;
		report.snapshotSha256 = createHash("sha256").update(sql).digest("hex");
		const expected = snapshot(recovered);
		const name = `tam-cap-restore-drill-${id.replaceAll("-", "")}`;
		report.plannedRestoreName = name;
		await writeFile(reportPath, JSON.stringify(report, null, 2));
		const database = await api(token, "/d1/database", { name });
		created = { id: database.uuid, name };
		assertRestoreTarget(created.id, created.name, created);
		report.restoreDatabase = created;
		await writeFile(reportPath, JSON.stringify(report, null, 2));
		const etag = createHash("md5").update(sql).digest("hex");
		const initialized = await api(token, `/d1/database/${created.id}/import`, {
			action: "init",
			etag,
		});
		if (initialized.upload_url) {
			const upload = await transfer(signedUrl(initialized.upload_url), {
				method: "PUT",
				body: sql,
			});
			await upload.body?.cancel();
		}
		await poll((bookmark) =>
			api(
				token,
				`/d1/database/${created.id}/import`,
				bookmark
					? { action: "poll", current_bookmark: bookmark }
					: { action: "ingest", etag, filename: initialized.filename },
			),
		);
		sql = "";
		const query = async (command) => {
			const results = await api(token, `/d1/database/${created.id}/query`, {
				sql: command,
			});
			if (!Array.isArray(results) || results.some((result) => !result.success))
				throw Error("Restore comparison query failed");
			return results;
		};
		const [restoredSchema] = await query(schemaSql);
		report.schemaMatches =
			schemaDigest(expected.schema) === schemaDigest(restoredSchema.results);
		report.tables = [];
		for (const name of expected.tables) {
			const [restored] = await query(
				`SELECT * FROM "${name.replaceAll('"', '""')}"`,
			);
			const rows = expected.rows.get(name);
			const expectedHash = rowDigest(rows);
			const restoredHash = rowDigest(restored.results);
			report.tables.push({
				name,
				rows: rows.length,
				matches:
					rows.length === restored.results.length &&
					expectedHash === restoredHash,
				sha256: expectedHash,
			});
		}
		const integrity = await query(
			"PRAGMA quick_check; PRAGMA foreign_key_check;",
		);
		report.integrityOk = integrity[0].results.every(
			(row) => row.quick_check === "ok",
		);
		report.foreignKeyViolations = integrity[1].results.length;
		if (
			!report.schemaMatches ||
			report.tables.some((table) => !table.matches) ||
			!report.integrityOk ||
			report.foreignKeyViolations
		)
			throw Error("Restored metadata verification failed");
		const videoRows = expected.rows.get("videos") ?? [];
		const video = videoRows.find((row) => row.id === sampleVideo);
		if (!video || typeof video.ownerId !== "string")
			throw Error("Authorized synthetic sample is absent from the snapshot");
		const sourcePrefix = `${video.ownerId}/${video.id}/`;
		const listing = await api(
			token,
			`/r2/buckets/${sourceBucket}/objects?prefix=${encodeURIComponent(sourcePrefix)}&per_page=1000`,
		);
		const objects = Array.isArray(listing) ? listing : listing.objects;
		const selected = sampleKeys(video);
		const raw = objects.find((value) => value.key === selected.raw);
		const derived = objects.find((value) => value.key === selected.derived);
		if (!raw || !derived)
			throw Error("Synthetic raw and derived media samples are required");
		const prefix = `.restore-test/${id}/`;
		report.samples = [];
		for (const [kind, item] of [
			["raw", raw],
			["derived", derived],
		]) {
			const source = await object(token, item.key);
			const bytes = new Uint8Array(await source.arrayBuffer());
			const hash = createHash("sha256").update(bytes).digest("hex");
			const key = `${prefix}${kind}.mp4`;
			createdKeys.add(key);
			const copied = await object(token, key, "PUT", bytes);
			await copied.body?.cancel();
			const restored = await object(token, key);
			const restoredBytes = new Uint8Array(await restored.arrayBuffer());
			const matches =
				restoredBytes.length === bytes.length &&
				createHash("sha256").update(restoredBytes).digest("hex") === hash;
			report.samples.push({
				kind,
				sourceKey: item.key,
				key,
				bytes: bytes.length,
				sha256: hash,
				matches,
			});
			if (!matches) throw Error("Restored media sample verification failed");
		}
		report.verified = true;
		await writeFile(reportPath, JSON.stringify(report, null, 2));
		for (const key of createdKeys) {
			assertSampleTarget(key, prefix, createdKeys);
			const deleted = await object(token, key, "DELETE");
			await deleted.body?.cancel();
			await verifyAbsent(
				token,
				`/r2/buckets/${sourceBucket}/objects/${key.split("/").map(encodeURIComponent).join("/")}`,
			);
		}
		report.samplesDeleted = true;
		const current = await api(token, `/d1/database/${created.id}`);
		assertRestoreTarget(current.uuid, current.name, created);
		await api(token, `/d1/database/${created.id}`, undefined, "DELETE");
		await verifyAbsent(token, `/d1/database/${created.id}`);
		report.databaseDeleted = true;
		report.completedAt = new Date().toISOString();
		await writeFile(reportPath, JSON.stringify(report, null, 2));
		return {
			id,
			report: reportPath,
			snapshotProtected: true,
			schemaMatches: true,
			tablesCompared: report.tables.length,
			rowsCompared: report.tables.reduce((sum, table) => sum + table.rows, 0),
			mediaSamplesVerified: report.samples.length,
			databaseDeleted: true,
			samplesDeleted: true,
		};
	} catch (error) {
		report.failure =
			error instanceof Error && !error.message.includes("http")
				? error.message
				: "Restore drill failed";
		report.retainedDatabase = created ?? null;
		report.retainedSampleKeys = [...createdKeys];
		await writeFile(reportPath, JSON.stringify(report, null, 2));
		throw Error(
			`Restore drill stopped; private recovery receipt: ${reportPath}`,
		);
	}
}

if (
	process.argv[1] &&
	import.meta.url === pathToFileURL(resolve(process.argv[1])).href
) {
	try {
		console.log(
			JSON.stringify(
				await runDrill(
					process.argv[2],
					process.argv[3] === "--snapshot" ? process.argv[4] : undefined,
				),
				null,
				2,
			),
		);
	} catch (error) {
		console.error(
			error instanceof Error ? error.message : "Restore drill failed",
		);
		process.exitCode = 1;
	}
}
