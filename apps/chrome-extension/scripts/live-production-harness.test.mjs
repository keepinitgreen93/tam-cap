import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import {
	parseProductionArguments,
	permittedProductionOwnerCookies,
	prepareProductionHarness,
	productionExtensionId,
	productionOrigin,
	productionPaths,
	productionRequestPolicy,
	runProductionHarness,
	safeProductionFailure,
	validateProductionOptions,
	validateProductionPackage,
} from "./live-production-harness.mjs";

test("production identity, package and private profile stay isolated from staging", async () => {
	const receipt = JSON.parse(
		await readFile(`${productionPaths.package}/BUILD.json`, "utf8"),
	);
	const bytes = await readFile(`${productionPaths.package}/manifest.json`);
	const manifest = JSON.parse(bytes.toString("utf8"));
	assert.doesNotThrow(() =>
		validateProductionPackage(receipt, manifest, bytes),
	);
	assert.equal(productionExtensionId, "ffocnmodhfclminiaapbfapkehcppkga");
	assert.equal(productionOrigin, "https://videos.trulyauthenticmarketing.com");
	assert.match(
		productionPaths.privateRoot,
		/[\\/]\.secrets[\\/]extension-production-live$/,
	);
	assert.match(
		productionPaths.ownerState,
		/[\\/]\.secrets[\\/]production-auth\.json$/,
	);
	for (const changed of [
		{ ...receipt, profile: "staging" },
		{ ...receipt, apiBaseUrl: "https://tam-cap-app.ciglesia.workers.dev" },
		{ ...receipt, extensionId: "ajkhoihmncjajolcphcjlnoooccldadm" },
	])
		assert.throws(
			() => validateProductionPackage(changed, manifest, bytes),
			/identity/,
		);
	assert.throws(
		() =>
			validateProductionPackage(
				receipt,
				{ ...manifest, homepage_url: "https://cap.so" },
				bytes,
			),
		/identity/,
	);
	assert.throws(
		() =>
			validateProductionPackage(
				receipt,
				{ ...manifest, key: "invalid" },
				bytes,
			),
		/identity/,
	);
	assert.throws(
		() =>
			validateProductionPackage(
				receipt,
				manifest,
				Buffer.from("different package"),
			),
		/identity/,
	);
});

test("production owner cookie import excludes staging, parent domains and unrelated instances", () => {
	const cookies = [
		{
			domain: "videos.trulyauthenticmarketing.com",
			value: "private-production-cookie",
		},
		{
			domain: ".videos.trulyauthenticmarketing.com",
			value: "private-production-domain-cookie",
		},
		{ domain: "tam-cap-app.ciglesia.workers.dev", value: "staging-cookie" },
		{ domain: ".trulyauthenticmarketing.com", value: "parent-cookie" },
		{
			domain: "videos.trulyauthenticmarketing.com.evil.test",
			value: "other-cookie",
		},
	];
	assert.deepEqual(
		permittedProductionOwnerCookies({ cookies }),
		cookies.slice(0, 2),
	);
	assert.deepEqual(permittedProductionOwnerCookies({}), []);
});

test("request policy never injects credentials and rejects preview headers at every origin", () => {
	for (const target of [
		productionOrigin,
		"https://sample.r2.cloudflarestorage.com/private?signature=hidden",
		"https://ffocnmodhfclminiaapbfapkehcppkga.chromiumapp.org/callback",
	]) {
		assert.equal(productionRequestPolicy(target), "native_network");
		assert.equal(
			productionRequestPolicy(target, { "x-cap-preview-key": "forbidden" }),
			"forbidden_header",
		);
		assert.equal(
			productionRequestPolicy(target, { "X-Cap-Preview-Key": "forbidden" }),
			"forbidden_header",
		);
	}
	assert.equal(
		productionRequestPolicy(
			`${productionOrigin}/__tam_extension_production_synthetic__`,
		),
		"synthetic_document",
	);
	assert.equal(
		productionRequestPolicy(
			"https://videos.trulyauthenticmarketing.com.evil.test/__tam_extension_production_synthetic__",
		),
		"native_network",
	);
	for (const target of [
		"https://tam-cap-app.ciglesia.workers.dev",
		"https://cap.so",
		"https://api.cap.so",
	])
		assert.equal(productionRequestPolicy(target), "forbidden_instance");
});

test("live authorization requires both owner editing and public production prerequisites", async () => {
	assert.deepEqual(parseProductionArguments(["--prepare"]), {
		goLive: false,
		options: { capture: false, ownerEditPassed: false, domainPublic: false },
	});
	assert.doesNotThrow(() =>
		validateProductionOptions({
			ownerEditPassed: true,
			domainPublic: true,
			capture: false,
		}),
	);
	for (const options of [
		{},
		{ ownerEditPassed: true },
		{ domainPublic: true },
		{
			ownerEditPassed: true,
			domainPublic: true,
			testIdentityReturnShim: false,
		},
		{ ownerEditPassed: true, domainPublic: true, previewKey: "forbidden" },
		{ ownerEditPassed: "true", domainPublic: true },
	]) {
		await assert.rejects(
			runProductionHarness(options),
			/prerequisites|forbidden/,
		);
	}
	for (const args of [
		["--test-identity-return-shim"],
		["--preview-key", "hidden"],
		["--capture"],
		["--prepare", "--go-live"],
		["--go-live", "--go-live"],
	])
		assert.throws(() => parseProductionArguments(args));
});

test("preparation performs no network access and waits for a separate production owner state", async () => {
	const original = globalThis.fetch;
	let networkCalls = 0;
	globalThis.fetch = async () => {
		networkCalls++;
		throw Error("Network forbidden in preparation");
	};
	try {
		const prepared = await prepareProductionHarness();
		assert.equal(prepared.mode, "prepared_only");
		assert.equal(prepared.networkStarted, false);
		assert.equal(prepared.identityRequirement, "native_chrome_identity");
		assert.equal(prepared.captureBudget, 1);
		assert.equal(prepared.extensionId, productionExtensionId);
		assert.equal(typeof prepared.ownerStateAvailable, "boolean");
		assert.equal(networkCalls, 0);
	} finally {
		globalThis.fetch = original;
	}
});

test("safe errors cannot expose URLs, signatures, auth codes or arbitrary exception text", () => {
	assert.equal(
		safeProductionFailure("identity_approval"),
		"production_extension_failed_at_identity_approval",
	);
	for (const unsafe of [
		"https://private.example?token=secret",
		"bearer-private-token",
		"capture?signature=secret",
		"123456",
		"identity_approval\nprivate",
	]) {
		const output = safeProductionFailure(unsafe);
		assert.equal(output, "production_extension_failed_at_unknown");
		assert(!output.includes(unsafe));
	}
});

test("production source has no preview file, network wrapper or native identity replacement", async () => {
	const source = await readFile(
		new URL("./live-production-harness.mjs", import.meta.url),
		"utf8",
	);
	assert.doesNotMatch(
		source,
		/cap-preview-key\.txt|staging-auth\.json|installPrivatePreviewFetch|globalThis\.fetch\s*=|launchWebAuthFlow\s*=/,
	);
	assert.doesNotMatch(
		source,
		/recordingMode:\s*"fullscreen"|auto-select-desktop-capture-source/,
	);
	assert.match(source, /recordingMode:\s*"tab"/);
	assert.match(source, /microphone:\s*\{\s*enabled:\s*false/);
	assert.match(source, /flag:\s*"wx"/);
	assert.match(source, /capture-budget\.json/);
	assert.match(source, /headless:\s*false/);
});
