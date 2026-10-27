import assert from "node:assert/strict";
import test from "node:test";
import {
	installPrivatePreviewFetch,
	permittedOwnerCookies,
	previewHeadersForUrl,
	stagingOrigin,
} from "./live-staging-harness.mjs";

test("preview navigation headers apply only to the exact staging origin", () => {
	const key = "synthetic-preview-test-key";
	assert.equal(
		previewHeadersForUrl(`${stagingOrigin}/api/extension/auth/start`, {}, key)[
			"x-cap-preview-key"
		],
		key,
	);
	for (const target of [
		"https://videos.trulyauthenticmarketing.com",
		"https://tam-cap-app.ciglesia.workers.dev.evil.test",
		"http://tam-cap-app.ciglesia.workers.dev",
		"https://example.r2.cloudflarestorage.com",
		"https://id.chromiumapp.org",
	]) {
		const headers = previewHeadersForUrl(
			target,
			{ "x-cap-preview-key": key, authorization: "synthetic-api-key" },
			key,
		);
		assert.equal(headers["x-cap-preview-key"], undefined);
		assert.equal(headers.authorization, "synthetic-api-key");
	}
});

test("worker preview fetch cannot forward the preview header or follow a staging redirect", async () => {
	const original = globalThis.fetch;
	const calls = [];
	globalThis.fetch = async (request) => {
		calls.push(request);
		return Response.json({ ok: true });
	};
	try {
		installPrivatePreviewFetch({
			origin: stagingOrigin,
			previewKey: "synthetic-preview-test-key",
		});
		await fetch(`${stagingOrigin}/api/extension/bootstrap`, {
			headers: { Authorization: "Bearer synthetic-api-key" },
		});
		await fetch("https://example.r2.cloudflarestorage.com/part", {
			headers: { "x-cap-preview-key": "must-be-stripped" },
			method: "PUT",
			body: "synthetic-media",
		});
		assert.equal(
			calls[0].headers.get("x-cap-preview-key"),
			"synthetic-preview-test-key",
		);
		assert.equal(
			calls[0].headers.get("authorization"),
			"Bearer synthetic-api-key",
		);
		assert.equal(calls[0].redirect, "manual");
		assert.equal(calls[1].headers.get("x-cap-preview-key"), null);
		assert.equal(await calls[1].text(), "synthetic-media");
	} finally {
		globalThis.fetch = original;
	}
});

test("owner cookie import is restricted to the staging host", () => {
	const state = {
		cookies: [
			{
				domain: new URL(stagingOrigin).hostname,
				value: "synthetic-owner-cookie",
			},
			{ domain: ".ciglesia.workers.dev", value: "unrelated-parent" },
			{ domain: "cap.so", value: "unrelated-cookie" },
		],
	};
	assert.deepEqual(permittedOwnerCookies(state), [state.cookies[0]]);
});
