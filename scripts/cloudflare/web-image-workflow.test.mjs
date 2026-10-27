import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { parseDocument } from "yaml";

const source = readFileSync(
	new URL("../../.github/workflows/tam-web-images.yml", import.meta.url),
	"utf8",
);
const document = parseDocument(source);
const workflow = document.toJS();
const steps = workflow.jobs.build.steps;

test("image workflow triggers only its own branch/path and accepts two fixed targets", () => {
	assert.deepEqual(document.errors, []);
	assert.deepEqual(workflow.on.push.branches, ["codex/cloudflare-self-host"]);
	assert.deepEqual(workflow.on.push.paths, [
		".github/workflows/tam-web-images.yml",
	]);
	assert.deepEqual(workflow.on.workflow_dispatch.inputs.target.options, [
		"staging",
		"production",
	]);
	assert.deepEqual(workflow.permissions, { contents: "read" });
	assert.equal(workflow.jobs.build["runs-on"], "ubuntu-24.04");
	assert.ok(workflow.jobs.build["timeout-minutes"] < 120);
	assert.equal(
		steps.find((step) => step.uses?.startsWith("actions/checkout@")).with[
			"persist-credentials"
		],
		false,
	);
});

test("both images use the Cloudflare Dockerfile and a single native AMD64 platform without attestations", () => {
	const builds = steps.filter((step) =>
		step.run?.includes("docker buildx build"),
	);
	assert.equal(builds.length, 2);
	for (const build of builds) {
		assert.match(build.run, /--platform linux\/amd64/);
		assert.match(build.run, /--provenance=false/);
		assert.match(build.run, /--file Dockerfile\.cloudflare/);
		assert.match(build.run, /--load/);
		assert.equal(build.env, undefined);
	}
	assert.match(builds[0].run, /--target web/);
	assert.match(builds[0].run, /NEXT_PUBLIC_WEB_URL=\$ORIGIN/);
	assert.match(builds[1].run, /--target media/);
	const selection = steps.find(
		(step) => step.name === "Select exact origin and revision tags",
	);
	assert.match(
		selection.run,
		/staging\) origin=https:\/\/tam-cap-app\.ciglesia\.workers\.dev/,
	);
	assert.match(
		selection.run,
		/production\) origin=https:\/\/videos\.trulyauthenticmarketing\.com/,
	);
	assert.match(selection.run, /tam-cap-web:sha-%s-%s/);
	assert.match(selection.run, /tam-cap-media:sha-%s-%s/);
});

test("registry-only credentials are confined to the push step and never passed to a build or artifact", () => {
	const credentials = steps.filter(
		(step) => step.env?.TAM_CAP_REGISTRY_PASSWORD,
	);
	assert.equal(credentials.length, 1);
	const push = credentials[0];
	assert.match(
		push.run,
		/printf '%s' "\$TAM_CAP_REGISTRY_PASSWORD" \| docker login registry\.cloudflare\.com --username "\$TAM_CAP_REGISTRY_USERNAME" --password-stdin/,
	);
	assert.match(push.run, /docker push "\$WEB_IMAGE_TAG"/);
	assert.match(push.run, /docker push "\$MEDIA_IMAGE_TAG"/);
	assert.match(push.run, /docker logout registry\.cloudflare\.com/);
	assert.match(push.run, /RepoDigests/);
	assert.match(push.run, /@sha256:/);
	for (const field of ["webImage", "mediaImage", "origin", "sourceRevision"])
		assert.ok(push.run.includes(`${field}:`) || push.run.includes(`${field},`));
	assert.deepEqual(
		[...source.matchAll(/secrets\.([A-Z_]+)/g)].map((match) => match[1]).sort(),
		["TAM_CAP_REGISTRY_PASSWORD", "TAM_CAP_REGISTRY_USERNAME"],
	);
	assert.equal(source.includes("wrangler deploy"), false);
	assert.equal(source.includes("ghcr.io"), false);
	const artifact = steps.find((step) =>
		step.uses?.startsWith("actions/upload-artifact@"),
	);
	assert.equal(artifact.with.path, "image-manifest.json");
});

test("every runner script parses as Bash without executing Docker or a WSL session", () => {
	const executable =
		process.platform === "win32" ? "C:/Program Files/Git/bin/bash.exe" : "bash";
	for (const step of steps.filter((entry) => entry.run)) {
		const result = spawnSync(executable, ["-n"], {
			input: step.run,
			encoding: "utf8",
		});
		assert.equal(
			result.status,
			0,
			`${step.name}: ${result.stderr || result.error?.message}`,
		);
	}
});

test("the generated artifact contains only exact immutable repository references and deployment metadata", () => {
	const push = steps.find((entry) => entry.env?.TAM_CAP_REGISTRY_PASSWORD);
	const script = /node --input-type=module <<'NODE'\n([\s\S]*?)\nNODE/.exec(
		push.run,
	)?.[1];
	assert.ok(script);
	const directory = mkdtempSync(path.join(tmpdir(), "tam-image-manifest-"));
	const namespace = workflow.jobs.build.env.REGISTRY_NAMESPACE;
	const digest = "a".repeat(64);
	for (const name of ["web", "media"])
		writeFileSync(
			path.join(directory, `tam-cap-${name}-digests.json`),
			JSON.stringify([`${namespace}/tam-cap-${name}@sha256:${digest}`]),
		);
	const env = {
		...process.env,
		REGISTRY_NAMESPACE: namespace,
		RUNNER_TEMP: directory,
		ORIGIN: "https://tam-cap-app.ciglesia.workers.dev",
		GITHUB_SHA: "b".repeat(40),
	};
	const result = spawnSync(
		process.execPath,
		["--input-type=module", "-e", script],
		{ cwd: directory, env, encoding: "utf8" },
	);
	assert.equal(result.status, 0, result.stderr);
	assert.deepEqual(
		JSON.parse(
			readFileSync(path.join(directory, "image-manifest.json"), "utf8"),
		),
		{
			webImage: `${namespace}/tam-cap-web@sha256:${digest}`,
			mediaImage: `${namespace}/tam-cap-media@sha256:${digest}`,
			origin: env.ORIGIN,
			sourceRevision: env.GITHUB_SHA,
		},
	);
	writeFileSync(
		path.join(directory, "tam-cap-web-digests.json"),
		JSON.stringify([`${namespace}/tam-cap-web:mutable-tag`]),
	);
	const rejected = spawnSync(
		process.execPath,
		["--input-type=module", "-e", script],
		{ cwd: directory, env, encoding: "utf8" },
	);
	assert.notEqual(rejected.status, 0);
});
