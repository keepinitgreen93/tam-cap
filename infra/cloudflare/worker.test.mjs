import assert from "node:assert/strict";
import test from "node:test";
import worker from "./worker.ts";

function bindings(failDatabase = false, failStorage = false) {
	return {
		DB: {
			prepare(query) {
				assert.equal(query, "SELECT 1 AS ok");
				return {
					async first() {
						if (failDatabase) throw new Error("private database detail");
						return { ok: 1 };
					},
				};
			},
		},
		VIDEOS: {
			async head(key) {
				assert.equal(key, "__platform_readiness_probe__");
				if (failStorage) throw new Error("private storage detail");
				return null;
			},
		},
	};
}

test("platform readiness checks both bindings without claiming Cap is live", async () => {
	const response = await worker.fetch(
		new Request("https://example.test/health"),
		bindings(),
	);
	assert.equal(response.status, 200);
	assert.deepEqual(await response.json(), {
		status: "ok",
		component: "cap-cloudflare-platform",
		applicationReady: false,
	});
	assert.equal(response.headers.get("cache-control"), "no-store");
});

test("binding failures return an unavailable response without exposing details", async () => {
	for (const env of [bindings(true), bindings(false, true)]) {
		const response = await worker.fetch(
			new Request("https://example.test/health"),
			env,
		);
		assert.equal(response.status, 503);
		assert.equal((await response.json()).status, "unavailable");
	}
});

test("unknown paths and mutation methods cannot access resources", async () => {
	const env = bindings(true, true);
	for (const [path, method, status] of [
		["/", "GET", 404],
		["/videos/private.mp4", "GET", 404],
		["/health", "POST", 405],
	]) {
		const response = await worker.fetch(
			new Request(`https://example.test${path}`, { method }),
			env,
		);
		assert.equal(response.status, status);
	}
});
