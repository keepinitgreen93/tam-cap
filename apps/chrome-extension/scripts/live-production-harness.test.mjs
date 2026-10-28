import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import {
	installStartResponseObserver,
	invokeProductionToolbar,
	parseProductionArguments,
	permittedProductionOwnerCookies,
	prepareProductionHarness,
	productionExtensionId,
	productionOrigin,
	productionPaths,
	productionRequestPolicy,
	recorderErrorEvidence,
	runProductionHarness,
	safeProductionFailure,
	validateProductionOptions,
	validateProductionPackage,
	validateZeroUploadRetry,
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
		options: {
			capture: false,
			ownerEditPassed: false,
			domainPublic: false,
			retryAfterZeroUploadFailure: false,
			instrumentedThirdStart: false,
			normalDeviceFourthStart: false,
		},
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

test("native toolbar invocation uses only the exact synthetic browser TAB target", async () => {
	const commands = [];
	let detached = false;
	const url = `${productionOrigin}/__tam_extension_production_synthetic__`;
	const protocol = {
		send: async (method, parameters) => {
			commands.push([method, parameters]);
			return {
				targetInfos: [
					{ type: "page", url, targetId: "page-not-tab" },
					{ type: "tab", url, targetId: "synthetic-tab" },
					{
						type: "tab",
						url: `${productionOrigin}/dashboard`,
						targetId: "other-tab",
					},
				],
			};
		},
		detach: async () => {
			detached = true;
		},
	};
	const context = {
		browser: () => ({ newBrowserCDPSession: async () => protocol }),
	};
	await invokeProductionToolbar(context, { url: () => url });
	assert.deepEqual(commands, [
		[
			"Target.getTargets",
			{ filter: [{ type: "tab", exclude: false }, { exclude: true }] },
		],
		[
			"Extensions.triggerAction",
			{ id: productionExtensionId, targetId: "synthetic-tab" },
		],
	]);
	assert.equal(detached, true);
	await assert.rejects(
		invokeProductionToolbar(context, {
			url: () => `${productionOrigin}/dashboard`,
		}),
		/synthetic_action_target_required/,
	);
	protocol.send = async () => ({
		targetInfos: [
			{ type: "tab", url },
			{ type: "tab", url },
		],
	});
	await assert.rejects(
		invokeProductionToolbar(context, { url: () => url }),
		/ambiguous/,
	);
});

test("one additional capture requires the preserved zero-upload invocation failure", () => {
	const budget = { attempts: 1, synthetic: true, tabOnly: true };
	const failure = {
		failure: "production_extension_failed_at_capture",
		forbiddenRequest: false,
	};
	const diagnostic = {
		recordingStarted: false,
		mediaStreamConsumed: false,
		putRequestsObserved: 0,
		state: { liveManifests: 0, failedRecordings: 0, capturedTabs: 0 },
		before: { category: "extension_action_not_invoked" },
		after: { permitted: true },
	};
	assert.doesNotThrow(() =>
		validateZeroUploadRetry(budget, failure, diagnostic),
	);
	for (const changed of [
		{ ...diagnostic, recordingStarted: true },
		{ ...diagnostic, putRequestsObserved: 1 },
		{ ...diagnostic, state: { ...diagnostic.state, liveManifests: 1 } },
	])
		assert.throws(() => validateZeroUploadRetry(budget, failure, changed));
	assert.throws(() =>
		validateZeroUploadRetry({ ...budget, attempts: 2 }, failure, diagnostic),
	);
	assert.throws(() =>
		validateZeroUploadRetry(
			budget,
			{ ...failure, failure: "production_extension_failed_at_upload" },
			diagnostic,
		),
	);
});

test("start observer preserves the real response and runtime error without touching auth messages", () => {
	const original = globalThis.chrome;
	const response = { ok: false, error: "Could not start video source" };
	globalThis.chrome = {
		runtime: {
			lastError: { message: "native-runtime-error" },
			sendMessage: (_message, callback) => {
				callback(response);
				return "original-result";
			},
		},
	};
	try {
		installStartResponseObserver();
		let actual;
		assert.equal(
			chrome.runtime.sendMessage(
				{ type: "start-recording", mode: "tab" },
				(value) => {
					actual = value;
				},
			),
			"original-result",
		);
		assert.equal(actual, response);
		assert.deepEqual(globalThis.__tamRecorderStartReply, {
			requestedMode: "tab",
			ok: false,
			error: response.error,
			runtimeError: "native-runtime-error",
			phase: null,
		});
		globalThis.__tamRecorderStartReply = null;
		chrome.runtime.sendMessage({ type: "bootstrap" }, () => {});
		assert.equal(globalThis.__tamRecorderStartReply, null);
	} finally {
		globalThis.chrome = original;
		delete globalThis.__tamRecorderStartReply;
	}
});

test("recorder diagnostics redact URLs, credentials and codes while retaining native error wording", () => {
	assert.equal(
		recorderErrorEvidence("Could not start video source"),
		"Could not start video source",
	);
	const redacted = recorderErrorEvidence(
		`Failed https://private.example/path?signature=hidden Bearer private-credential-here ${"a".repeat(48)} 123456`,
	);
	for (const value of [
		"private.example",
		"signature=hidden",
		"private-credential-here",
		"a".repeat(48),
		"123456",
	])
		assert(!redacted.includes(value));
});
