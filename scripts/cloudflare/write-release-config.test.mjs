import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
	existsSync,
	linkSync,
	mkdirSync,
	mkdtempSync,
	readdirSync,
	readFileSync,
	realpathSync,
	rmSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import { createRequire } from "node:module";
import { homedir, tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import Ajv from "ajv";

const repo = fileURLToPath(new URL("../../", import.meta.url));
const script = path.join(repo, "scripts/cloudflare/write-release-config.mjs");
const template = JSON.parse(
	readFileSync(
		path.join(repo, "infra/cloudflare/wrangler.runtime.jsonc"),
		"utf8",
	),
);
const account = "c1e96a4b36c73f3cf4ddf50a90082d94";
const namespace = `registry.cloudflare.com/${account}`;
const manifest = (target = "staging") => ({
	webImage: `${namespace}/tam-cap-web@sha256:${"a".repeat(64)}`,
	mediaImage: `${namespace}/tam-cap-media@sha256:${"b".repeat(64)}`,
	origin:
		target === "staging"
			? "https://tam-cap-app.ciglesia.workers.dev"
			: "https://videos.trulyauthenticmarketing.com",
	sourceRevision: "c".repeat(40),
});
async function fixture(run) {
	const root = realpathSync.native(
		mkdtempSync(path.join(tmpdir(), "tam-release-config-")),
	);
	try {
		mkdirSync(path.join(root, "infra/cloudflare"), { recursive: true });
		writeFileSync(
			path.join(root, "infra/cloudflare/wrangler.runtime.jsonc"),
			JSON.stringify(template),
		);
		const artifact = path.join(root, "image-manifest.json");
		writeFileSync(artifact, JSON.stringify(manifest()));
		await run({ root, artifact });
	} finally {
		assert.equal(path.dirname(root), realpathSync.native(tmpdir()));
		assert.ok(path.basename(root).startsWith("tam-release-config-"));
		rmSync(root, { recursive: true, force: true });
	}
}
const api = () => import("./write-release-config.mjs");

test("CLI exposes only local generation flags and performs no authentication or deployment", () => {
	const result = spawnSync(process.execPath, [script, "--help"], {
		cwd: repo,
		encoding: "utf8",
	});
	assert.equal(result.status, 0, result.stderr);
	for (const flag of [
		"--manifest",
		"--target",
		"--output",
		"--ready",
		"--maintenance",
		"--force",
	])
		assert.ok(result.stdout.includes(flag));
	assert.doesNotMatch(
		readFileSync(script, "utf8"),
		/child_process|fetch\(|process\.env|execSync|spawn\(/,
	);
});

test("default release clones bindings/policies and pins images with closed gates", async () => {
	await fixture(async ({ root, artifact }) => {
		const { writeReleaseConfig } = await api();
		const output = await writeReleaseConfig(
			{ manifest: artifact, target: "staging" },
			root,
		);
		assert.equal(
			output,
			path.join(
				root,
				`infra/cloudflare/releases/staging-${"c".repeat(40)}.json`,
			),
		);
		const config = JSON.parse(readFileSync(output, "utf8"));
		assert.equal(config.name, template.name);
		assert.equal(config.account_id, account);
		assert.equal(config.main, "../runtime-worker.ts");
		assert.equal(config.vars.CAP_DEPLOYMENT_ID, manifest().sourceRevision);
		assert.equal(config.vars.CAP_WEB_IMAGE_REVISION, manifest().webImage);
		assert.equal(config.vars.CAP_RUNTIME_READY, "false");
		assert.equal(config.vars.CAP_MAINTENANCE_ENABLED, "false");
		assert.equal(config.workers_dev, true);
		assert.deepEqual(config.routes, []);
		for (const key of [
			"durable_objects",
			"migrations",
			"queues",
			"r2_buckets",
			"compatibility_flags",
			"triggers",
		])
			assert.deepEqual(config[key], template[key]);
		for (const [index, container] of config.containers.entries()) {
			assert.deepEqual(container.images.base, {
				image: index === 0 ? manifest().webImage : manifest().mediaImage,
			});
			assert.equal(container.scheduling_policy, "durable_object");
			assert.deepEqual(
				{ ...container, images: template.containers[index].images },
				template.containers[index],
			);
		}
		for (const [index, database] of config.d1_databases.entries()) {
			assert.equal(
				path.resolve(path.dirname(output), database.migrations_dir),
				path.resolve(
					root,
					"infra/cloudflare",
					template.d1_databases[index].migrations_dir,
				),
			);
			assert.deepEqual(
				{
					...database,
					migrations_dir: template.d1_databases[index].migrations_dir,
				},
				template.d1_databases[index],
			);
		}
	});
});

test("production selects only its custom domain and explicit gates", async () => {
	await fixture(async ({ root, artifact }) => {
		writeFileSync(artifact, JSON.stringify(manifest("production")));
		const { writeReleaseConfig } = await api();
		const output = await writeReleaseConfig(
			{
				manifest: artifact,
				target: "production",
				output: "infra/cloudflare/releases/production/current.json",
				ready: true,
				maintenance: true,
			},
			root,
		);
		const config = JSON.parse(readFileSync(output, "utf8"));
		assert.equal(config.main, "../../runtime-worker.ts");
		assert.equal(config.workers_dev, false);
		assert.deepEqual(config.routes, [
			{ pattern: "videos.trulyauthenticmarketing.com", custom_domain: true },
		]);
		assert.equal(config.vars.CAP_RUNTIME_READY, "true");
		assert.equal(config.vars.CAP_MAINTENANCE_ENABLED, "true");
	});
});

for (const [label, patch] of [
	["wrong staging origin", { origin: manifest("production").origin }],
	["origin suffix", { origin: `${manifest().origin}/` }],
	[
		"wrong account",
		{ webImage: manifest().webImage.replace(account, "d".repeat(32)) },
	],
	[
		"wrong repository",
		{ webImage: manifest().webImage.replace("tam-cap-web@", "other-web@") },
	],
	["swapped images", { mediaImage: manifest().webImage }],
	["mutable tag", { webImage: `${namespace}/tam-cap-web:latest` }],
	["short digest", { webImage: `${namespace}/tam-cap-web@sha256:abcd` }],
	[
		"uppercase digest",
		{ webImage: `${namespace}/tam-cap-web@sha256:${"A".repeat(64)}` },
	],
	["invalid source", { sourceRevision: "g".repeat(40) }],
	["short source", { sourceRevision: "a".repeat(7) }],
	["extra manifest field", { token: "synthetic-rejected-field" }],
])
	test(`rejects ${label} before creating an output`, async () => {
		await fixture(async ({ root, artifact }) => {
			writeFileSync(artifact, JSON.stringify({ ...manifest(), ...patch }));
			const { writeReleaseConfig } = await api();
			await assert.rejects(
				writeReleaseConfig({ manifest: artifact, target: "staging" }, root),
			);
			assert.equal(
				existsSync(path.join(root, "infra/cloudflare/releases")),
				false,
			);
		});
	});

for (const output of [
	"../outside.json",
	"infra/cloudflare/releases/../outside.json",
	"infra/cloudflare/releases/nested/../../outside.json",
	"infra/cloudflare/wrangler.runtime.jsonc",
	"/tmp/out.json",
	"C:\\Temp\\out.json",
	"infra/cloudflare/releases/%2e%2e/out.json",
	"infra/cloudflare/releases/x.txt",
	"infra/cloudflare/releases/CON.json",
	"infra/cloudflare/releases/NUL/out.json",
	"infra/cloudflare/releases/folder./out.json",
])
	test(`rejects unsafe destination ${output}`, async () => {
		await fixture(async ({ root, artifact }) => {
			const { writeReleaseConfig } = await api();
			await assert.rejects(
				writeReleaseConfig(
					{ manifest: artifact, target: "staging", output },
					root,
				),
				/destination|output/i,
			);
		});
	});

test("force only replaces an exact generated config for the same target and resets gates by default", async () => {
	await fixture(async ({ root, artifact }) => {
		const { writeReleaseConfig } = await api();
		const options = {
			manifest: artifact,
			target: "staging",
			output: "infra/cloudflare/releases/current.json",
		};
		const output = await writeReleaseConfig(
			{ ...options, ready: true, maintenance: true },
			root,
		);
		const original = readFileSync(output, "utf8");
		await assert.rejects(writeReleaseConfig(options, root), /exists|force/i);
		assert.equal(readFileSync(output, "utf8"), original);
		await writeReleaseConfig({ ...options, force: true }, root);
		assert.equal(
			JSON.parse(readFileSync(output, "utf8")).vars.CAP_RUNTIME_READY,
			"false",
		);
		assert.equal(
			JSON.parse(readFileSync(output, "utf8")).vars.CAP_MAINTENANCE_ENABLED,
			"false",
		);
		writeFileSync(artifact, JSON.stringify(manifest("production")));
		await assert.rejects(
			writeReleaseConfig(
				{ ...options, target: "production", force: true },
				root,
			),
			/generated|target/i,
		);
	});
});

for (const patch of [
	{ name: "unrelated-app" },
	{ account_id: "e".repeat(32) },
	{ vars: { CAP_RUNTIME_READY: "true" } },
	{ queues: {} },
	{ custom: "unknown" },
])
	test("force preserves unknown or modified configurations", async () => {
		await fixture(async ({ root, artifact }) => {
			const { writeReleaseConfig } = await api();
			const options = {
				manifest: artifact,
				target: "staging",
				output: "infra/cloudflare/releases/current.json",
			};
			const output = await writeReleaseConfig(options, root);
			const modified = JSON.stringify({
				...JSON.parse(readFileSync(output, "utf8")),
				...patch,
			});
			writeFileSync(output, modified);
			await assert.rejects(
				writeReleaseConfig({ ...options, force: true }, root),
				/generated|account|application/i,
			);
			assert.equal(readFileSync(output, "utf8"), modified);
		});
	});

test("rejects symbolic-link destinations without writing through them", async () => {
	await fixture(async ({ root, artifact }) => {
		const outside = realpathSync.native(
			mkdtempSync(path.join(tmpdir(), "tam-release-outside-")),
		);
		try {
			mkdirSync(path.join(root, "infra/cloudflare/releases"));
			symlinkSync(
				outside,
				path.join(root, "infra/cloudflare/releases/linked"),
				process.platform === "win32" ? "junction" : "dir",
			);
			const { writeReleaseConfig } = await api();
			await assert.rejects(
				writeReleaseConfig(
					{
						manifest: artifact,
						target: "staging",
						output: "infra/cloudflare/releases/linked/out.json",
					},
					root,
				),
				/symbolic|link|destination/i,
			);
			assert.throws(() => readFileSync(path.join(outside, "out.json")));
		} finally {
			assert.equal(path.dirname(outside), realpathSync.native(tmpdir()));
			assert.ok(path.basename(outside).startsWith("tam-release-outside-"));
			rmSync(outside, { recursive: true, force: true });
		}
	});
});

test("parses JSONC template comments without weakening manifest JSON validation", async () => {
	await fixture(async ({ root, artifact }) => {
		const file = path.join(root, "infra/cloudflare/wrangler.runtime.jsonc");
		writeFileSync(
			file,
			`// checked runtime template\n${JSON.stringify(template)}`,
		);
		const { writeReleaseConfig } = await api();
		await writeReleaseConfig({ manifest: artifact, target: "staging" }, root);
		writeFileSync(artifact, "{broken-json secret-not-printed");
		await assert.rejects(
			writeReleaseConfig({ manifest: artifact, target: "staging" }, root),
			(error) => !error.message.includes("secret-not-printed"),
		);
	});
});

test("CLI rejects duplicate, unknown and ambiguous boolean arguments", async () => {
	const { parseArguments } = await api();
	for (const args of [
		["--target", "staging", "--target", "production"],
		["--ready=false"],
		["--ready", "false"],
		["--unknown"],
		["--manifest"],
		["--target", "preview"],
	])
		assert.throws(() => parseArguments(args));
});

test("rejects an output hard link before replacing another file", async () => {
	await fixture(async ({ root, artifact }) => {
		const { writeReleaseConfig } = await api();
		const options = {
			manifest: artifact,
			target: "staging",
			output: "infra/cloudflare/releases/current.json",
		};
		const file = await writeReleaseConfig(options, root);
		const previous = readFileSync(file, "utf8");
		linkSync(file, path.join(root, "linked-config.json"));
		await assert.rejects(
			writeReleaseConfig({ ...options, force: true }, root),
			/link|unsupported/i,
		);
		assert.equal(readFileSync(file, "utf8"), previous);
	});
});

test("rejects template identity, policy and reference paths that escape the repository", async () => {
	await fixture(async ({ root }) => {
		const { buildReleaseConfig } = await api();
		for (const change of [
			{ name: "other-app" },
			{ account_id: "f".repeat(32) },
			{ main: "../../../outside.ts" },
			{
				d1_databases: [
					{ ...template.d1_databases[0], migrations_dir: "../../../outside" },
				],
			},
			{
				containers: template.containers.map((entry) => ({
					...entry,
					scheduling_policy: "default",
				})),
			},
		])
			assert.throws(() =>
				buildReleaseConfig({ ...template, ...change }, manifest(), {
					root,
					target: "staging",
					output: "infra/cloudflare/releases/out.json",
				}),
			);
	});
});

test("readiness, maintenance and force accept only explicit boolean state", async () => {
	await fixture(async ({ root, artifact }) => {
		const { writeReleaseConfig } = await api();
		for (const key of ["ready", "maintenance", "force"])
			for (const value of ["true", "false", 1, null])
				await assert.rejects(
					writeReleaseConfig(
						{ manifest: artifact, target: "staging", [key]: value },
						root,
					),
					/boolean/i,
				);
	});
});

test("staging origin cannot be reused for a production build", async () => {
	const { validateManifest } = await api();
	assert.throws(() => validateManifest(manifest(), "production"), /origin/i);
});

for (const flag of ["ready", "maintenance"])
	test(`enables only the explicit ${flag} switch`, async () => {
		await fixture(async ({ root, artifact }) => {
			const { writeReleaseConfig } = await api();
			const file = await writeReleaseConfig(
				{ manifest: artifact, target: "staging", [flag]: true },
				root,
			);
			const config = JSON.parse(readFileSync(file, "utf8"));
			assert.equal(config.vars.CAP_RUNTIME_READY, String(flag === "ready"));
			assert.equal(
				config.vars.CAP_MAINTENANCE_ENABLED,
				String(flag === "maintenance"),
			);
		});
	});

test("force advances immutable references and source without changing resource bindings", async () => {
	await fixture(async ({ root, artifact }) => {
		const { writeReleaseConfig } = await api();
		const options = {
			manifest: artifact,
			target: "staging",
			output: "infra/cloudflare/releases/current.json",
		};
		const file = await writeReleaseConfig(options, root);
		const before = JSON.parse(readFileSync(file, "utf8"));
		const next = {
			...manifest(),
			sourceRevision: "d".repeat(40),
			webImage: `${namespace}/tam-cap-web@sha256:${"e".repeat(64)}`,
		};
		writeFileSync(artifact, JSON.stringify(next));
		await writeReleaseConfig({ ...options, force: true }, root);
		const config = JSON.parse(readFileSync(file, "utf8"));
		assert.equal(config.vars.CAP_DEPLOYMENT_ID, next.sourceRevision);
		assert.equal(config.vars.CAP_WEB_IMAGE_REVISION, next.webImage);
		assert.deepEqual(config.containers[0].images.base, {
			image: next.webImage,
		});
		for (const key of [
			"durable_objects",
			"migrations",
			"d1_databases",
			"r2_buckets",
			"queues",
		])
			assert.deepEqual(config[key], before[key]);
	});
});

function installedWranglerSchema() {
	const candidates = [];
	if (process.env.CAP_WRANGLER_SCHEMA)
		candidates.push(process.env.CAP_WRANGLER_SCHEMA);
	try {
		candidates.push(
			createRequire(import.meta.url).resolve("wrangler/config-schema.json"),
		);
	} catch {}
	for (const cache of [
		process.env.npm_config_cache,
		process.env.LOCALAPPDATA
			? path.join(process.env.LOCALAPPDATA, "npm-cache")
			: undefined,
		path.join(homedir(), ".npm"),
	]) {
		if (!cache || !existsSync(path.join(cache, "_npx"))) continue;
		for (const entry of readdirSync(path.join(cache, "_npx")))
			candidates.push(
				path.join(
					cache,
					"_npx",
					entry,
					"node_modules/wrangler/config-schema.json",
				),
			);
	}
	for (const file of candidates) {
		if (!existsSync(file)) continue;
		const pkg = JSON.parse(
			readFileSync(path.join(path.dirname(file), "package.json"), "utf8"),
		);
		if (pkg.name === "wrangler" && pkg.version === "4.152.0") return file;
	}
	assert.fail(
		"Install Wrangler 4.152.0 or set CAP_WRANGLER_SCHEMA to its config-schema.json for the release contract test",
	);
}

test("generated staging and production configs validate against installed Wrangler 4.152.0 schema", async () => {
	const schema = JSON.parse(readFileSync(installedWranglerSchema(), "utf8"));
	const validate = new Ajv({ allErrors: true, strict: false }).compile(schema);
	const { buildReleaseConfig } = await api();
	for (const target of ["staging", "production"]) {
		const config = buildReleaseConfig(template, manifest(target), {
			root: repo,
			target,
			output: `infra/cloudflare/releases/${target}-schema-contract.json`,
		});
		assert.equal(validate(config), true, JSON.stringify(validate.errors));
		const invalid = structuredClone(config);
		invalid.containers[0].images.base = manifest(target).webImage;
		assert.equal(
			validate(invalid),
			false,
			"the installed schema must reject the former scalar image shape",
		);
	}
});
