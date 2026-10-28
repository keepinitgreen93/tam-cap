import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
	existsSync,
	mkdtempSync,
	readFileSync,
	realpathSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { parseDocument } from "yaml";

const source = readFileSync(
	new URL("../../.github/workflows/tam-media-image.yml", import.meta.url),
	"utf8",
);
const document = parseDocument(source);
const workflow = document.toJS();
const steps = workflow.jobs.build.steps;
const namespace = "registry.cloudflare.com/c1e96a4b36c73f3cf4ddf50a90082d94";

test("media CI bootstraps only its branch/path with read-only checkout and one Linux AMD64 media build", () => {
	assert.deepEqual(document.errors, []);
	assert.ok(Object.hasOwn(workflow.on, "workflow_dispatch"));
	assert.deepEqual(workflow.on.push, {
		branches: ["codex/cloudflare-self-host"],
		paths: [".github/workflows/tam-media-image.yml"],
	});
	assert.deepEqual(workflow.permissions, { contents: "read" });
	assert.equal(
		workflow.jobs.build.if,
		"github.ref == 'refs/heads/codex/cloudflare-self-host'",
	);
	assert.equal(workflow.jobs.build["runs-on"], "ubuntu-24.04");
	assert.ok(workflow.jobs.build["timeout-minutes"] < 120);
	assert.equal(workflow.jobs.build.env.REGISTRY_NAMESPACE, namespace);
	assert.equal(
		steps.find((step) => step.uses?.startsWith("actions/checkout@")).with[
			"persist-credentials"
		],
		false,
	);
	assert.equal(
		steps.find((step) => step.uses?.startsWith("actions/setup-node@")).with[
			"node-version"
		],
		24,
	);
	assert.ok(
		steps.some((step) => step.uses?.startsWith("docker/setup-buildx-action@")),
	);
	const builds = steps.filter((step) =>
		step.run?.includes("docker buildx build"),
	);
	assert.equal(builds.length, 1);
	for (const pattern of [
		/--target media/,
		/--platform linux\/amd64/,
		/--file Dockerfile\.cloudflare/,
		/--load/,
		/--provenance=false/,
		/tam-cap-media:sha-\$GITHUB_SHA-media/,
	])
		assert.match(builds[0].run, pattern);
	assert.doesNotMatch(
		source,
		/--target web|next build|wrangler deploy|ghcr\.io/,
	);
});

test("only the push step receives registry credentials and cleans isolated Docker auth", () => {
	const privileged = steps.filter(
		(step) => step.env?.TAM_CAP_REGISTRY_PASSWORD,
	);
	assert.equal(privileged.length, 1);
	const push = privileged[0];
	assert.deepEqual(
		[...source.matchAll(/secrets\.([A-Z_]+)/g)].map((match) => match[1]).sort(),
		["TAM_CAP_REGISTRY_PASSWORD", "TAM_CAP_REGISTRY_USERNAME"],
	);
	assert.match(push.env.DOCKER_CONFIG, /runner.temp/);
	assert.match(
		push.run,
		/printf '%s' "\$TAM_CAP_REGISTRY_PASSWORD" \| docker login registry\.cloudflare\.com --username "\$TAM_CAP_REGISTRY_USERNAME" --password-stdin/,
	);
	assert.match(push.run, /trap .*docker logout.*config\.json.* EXIT/);
	assert.match(push.run, /docker push "\$MEDIA_IMAGE_TAG"/);
	for (const step of steps.filter((step) => step !== push))
		assert.equal(step.env, undefined);
	const artifact = steps.find((step) =>
		step.uses?.startsWith("actions/upload-artifact@"),
	);
	assert.equal(artifact.with.name, "tam-cap-media-image-manifest");
	assert.equal(artifact.with.path, "media-image-manifest.json");
	assert.equal(artifact.with["if-no-files-found"], "error");
});

test("runner scripts parse as Bash without running Docker", () => {
	const bash =
		process.platform === "win32" ? "C:/Program Files/Git/bin/bash.exe" : "bash";
	for (const step of steps.filter((step) => step.run)) {
		const result = spawnSync(bash, ["-n"], {
			input: step.run,
			encoding: "utf8",
		});
		assert.equal(result.status, 0, result.stderr || result.error?.message);
	}
});

const manifestScript = () => {
	const push = steps.find((step) => step.env?.TAM_CAP_REGISTRY_PASSWORD);
	const script = /node --input-type=module <<'NODE'\n([\s\S]*?)\nNODE/.exec(
		push.run,
	)?.[1];
	assert.ok(script);
	return script;
};
function runManifest(values, changes = {}) {
	const directory = realpathSync.native(
		mkdtempSync(path.join(tmpdir(), "tam-media-manifest-")),
	);
	try {
		writeFileSync(
			path.join(directory, "tam-cap-media-digests.json"),
			JSON.stringify(values),
		);
		const result = spawnSync(
			process.execPath,
			["--input-type=module", "-e", manifestScript()],
			{
				cwd: directory,
				env: {
					...process.env,
					RUNNER_TEMP: directory,
					REGISTRY_NAMESPACE: namespace,
					GITHUB_SHA: "b".repeat(40),
					...changes,
				},
				encoding: "utf8",
			},
		);
		const file = path.join(directory, "media-image-manifest.json");
		return {
			...result,
			manifest: existsSync(file)
				? JSON.parse(readFileSync(file, "utf8"))
				: undefined,
		};
	} finally {
		assert.equal(path.dirname(directory), realpathSync.native(tmpdir()));
		assert.ok(path.basename(directory).startsWith("tam-media-manifest-"));
		rmSync(directory, { recursive: true, force: true });
	}
}
const digest = `${namespace}/tam-cap-media@sha256:${"a".repeat(64)}`;
test("artifact contains only the immutable media reference and full source revision", () => {
	const result = runManifest([digest]);
	assert.equal(result.status, 0, result.stderr);
	assert.deepEqual(result.manifest, {
		mediaImage: digest,
		sourceRevision: "b".repeat(40),
	});
});
for (const [label, values, changes] of [
	["wrong repository", [digest.replace("tam-cap-media@", "tam-cap-web@")], {}],
	[
		"wrong account",
		[digest.replace("c1e96a4b36c73f3cf4ddf50a90082d94", "f".repeat(32))],
		{},
	],
	["mutable tag", [`${namespace}/tam-cap-media:latest`], {}],
	["short digest", [`${namespace}/tam-cap-media@sha256:abc`], {}],
	["duplicate digest", [digest, digest], {}],
	["non-array digests", {}, {}],
	["invalid source", [digest], { GITHUB_SHA: "g".repeat(40) }],
	["short source", [digest], { GITHUB_SHA: "a".repeat(7) }],
	[
		"wrong namespace",
		[digest],
		{ REGISTRY_NAMESPACE: "registry.example.invalid/account" },
	],
])
	test(`manifest rejects ${label} without creating an artifact`, () => {
		const result = runManifest(values, changes);
		assert.notEqual(result.status, 0);
		assert.equal(result.manifest, undefined);
	});
