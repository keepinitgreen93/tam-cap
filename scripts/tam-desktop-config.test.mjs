import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { gpuiDirectory, resolveBundleConfigs } from "./bundle-gpui.mjs";

const root = fileURLToPath(new URL("../", import.meta.url));
const native = path.join(root, "apps/desktop-gpui/src");
const source = (name) => readFileSync(path.join(native, name), "utf8");

test("fork packaging keeps a separate identity and removes upstream update/deep-link registration", () => {
	const config = JSON.parse(
		readFileSync(
			path.join(root, "apps/desktop-gpui/tauri.tam.conf.json"),
			"utf8",
		),
	);
	assert.equal(config.identifier, "com.trulyauthenticmarketing.cap");
	assert.equal(config.productName, "TAM Cap");
	assert.equal(config.mainBinaryName, "Cap");
	assert.equal(config.bundle.createUpdaterArtifacts, false);
	assert.equal(config.plugins.updater, null);
	assert.equal(config.plugins["deep-link"], null);
	assert.equal(
		(
			source("store.rs").match(
				/\.join\(crate::distribution::INSTANCE_IDENTIFIER\)/g,
			) ?? []
		).length,
		3,
	);
});

test("bundle config files resolve under GPUI regardless of caller working directory", () => {
	const expected = path.join(gpuiDirectory, "tauri.tam.conf.json");
	assert.deepEqual(
		resolveBundleConfigs([
			"--bundles",
			"nsis",
			"--config",
			"tauri.tam.conf.json",
		]),
		["--bundles", "nsis", "--config", expected],
	);
	assert.deepEqual(resolveBundleConfigs(["--config=tauri.tam.conf.json"]), [
		`--config=${expected}`,
	]);
	assert.deepEqual(
		resolveBundleConfigs(["-c", '{"bundle":{"createUpdaterArtifacts":false}}']),
		["-c", '{"bundle":{"createUpdaterArtifacts":false}}'],
	);
	assert.throws(() => resolveBundleConfigs(["--config"]), /Missing/);
});

test("every updater provider and installer boundary enforces organization-managed builds", () => {
	const text = source("installer.rs");
	for (const name of [
		"client",
		"fetch_release",
		"download",
		"install_app_bundle",
		"launch_installer",
		"install_deb",
		"install_appimage",
	]) {
		const start = text.indexOf(`fn ${name}(`);
		assert.ok(start >= 0, name);
		const body = text.slice(text.indexOf("{", start) + 1);
		assert.match(
			body,
			/^\s*crate::distribution::require_automatic_updates\(\)\?;/,
			name,
		);
	}
	const updates = source("updates.rs");
	for (const name of [
		"check_manually",
		"update_channel_changed",
		"schedule_startup_check",
		"update_download_policy_changed",
		"start_download",
		"install_and_relaunch",
	]) {
		const start = updates.indexOf(`fn ${name}(`);
		assert.ok(start >= 0, name);
		assert.match(
			updates.slice(updates.indexOf("{", start) + 1),
			/^\s*if crate::distribution::SELF_HOSTED_BUILD/,
			name,
		);
	}
	assert.match(source("settings_window.rs"), /Organization-managed updates/);
	assert.match(source("menus.rs"), /Organization-managed updates/);
});

test("the distribution probe exits before logs, profile state, single-instance checks or UI", () => {
	const main = source("main.rs");
	const entry = main.slice(main.indexOf("fn main() {"));
	assert.match(entry, /^fn main\(\) \{\s*if std::env::args\(\).any\(\|argument\| argument == "--print-distribution"\)/);
	const probe = entry.slice(0, entry.indexOf("return;"));
	for (const field of ["selfHosted", "serverUrl", "instanceIdentifier", "automaticUpdates"]) assert.ok(probe.includes(`"${field}"`), field);
	for (const forbidden of ["init_logging(", "single_instance::", "GeneralSettings::load", "gpui_platform::"]) assert.equal(probe.includes(forbidden), false, forbidden);
});

for (const hosted of [false, true]) {
	test(`Rust distribution constants compile with self-hosted mode ${hosted}`, () => {
		const directory = mkdtempSync(path.join(tmpdir(), "tam-distribution-"));
		const file = path.join(directory, "verify.rs");
		const expectedOrigin = hosted
			? "https://videos.trulyauthenticmarketing.com"
			: "https://cap.so";
		const expectedIdentity = hosted
			? "com.trulyauthenticmarketing.cap"
			: "so.cap.desktop";
		writeFileSync(
			file,
			`#[path = ${JSON.stringify(path.join(native, "distribution.rs"))}] mod distribution;\nconst fn equal(a: &str, b: &str) -> bool { let a = a.as_bytes(); let b = b.as_bytes(); if a.len() != b.len() { return false; } let mut i = 0; while i < a.len() { if a[i] != b[i] { return false; } i += 1; } true }\nconst _: () = assert!(distribution::SELF_HOSTED_BUILD == ${hosted});\nconst _: () = assert!(equal(distribution::DEFAULT_SERVER_URL, ${JSON.stringify(expectedOrigin)}));\nconst _: () = assert!(equal(distribution::INSTANCE_IDENTIFIER, ${JSON.stringify(expectedIdentity)}));\n`,
		);
		const env = { ...process.env };
		for (const key of [
			"CAP_SELF_HOSTED_BUILD",
			"CAP_INSTANCE_IDENTIFIER",
			"VITE_SERVER_URL",
		])
			delete env[key];
		if (hosted)
			Object.assign(env, {
				CAP_SELF_HOSTED_BUILD: "true",
				CAP_INSTANCE_IDENTIFIER: expectedIdentity,
				VITE_SERVER_URL: expectedOrigin,
			});
		const result = spawnSync(
			"rustc",
			[
				"--edition=2024",
				"--crate-type=lib",
				"--emit=metadata",
				file,
				"-o",
				path.join(directory, "verified.rmeta"),
			],
			{ env, encoding: "utf8" },
		);
		assert.equal(result.status, 0, result.stderr || result.error?.message);
	});
}
