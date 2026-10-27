import assert from "node:assert/strict";
import test from "node:test";
import { build } from "esbuild";
import { Miniflare } from "miniflare";

test("installer downloads stream private R2 artifacts with safe cache and filename headers", async () => {
	const bundle = await build({
		stdin: {
			contents:
				'import { downloadArtifact } from "./downloads.ts"; export default {fetch(request,env){return downloadArtifact(request,new URL(request.url).pathname,env.ARTIFACTS,request.headers.has("x-test-preview"));}}',
			resolveDir: import.meta.dirname,
		},
		bundle: true,
		write: false,
		format: "esm",
		platform: "neutral",
	});
	const mf = new Miniflare({
		modules: true,
		script: bundle.outputFiles[0].text,
		r2Buckets: { ARTIFACTS: "test-downloads" },
	});
	try {
		const bucket = await mf.getR2Bucket("ARTIFACTS");
		const key = "v0.6.1-tam.1/TAMCap-Chrome.zip";
		await bucket.put(key, "synthetic-extension-archive");
		const request = new Request(`https://cap.example/downloads/${key}`);
		const response = await mf.dispatchFetch(request.url);
		assert.equal(response.status, 200);
		assert.equal(await response.text(), "synthetic-extension-archive");
		assert.equal(
			response.headers.get("Content-Disposition"),
			'attachment; filename="TAMCap-Chrome.zip"',
		);
		assert.match(response.headers.get("Cache-Control"), /immutable/);
		const etag = response.headers.get("ETag");
		const unchanged = await mf.dispatchFetch(request.url, {
			headers: { "if-none-match": etag },
		});
		assert.equal(unchanged.status, 304);
		const head = await mf.dispatchFetch(request.url, {
			method: "HEAD",
			headers: { "x-test-preview": "true" },
		});
		assert.equal(head.status, 200);
		assert.equal(await head.text(), "");
		assert.equal(head.headers.get("Cache-Control"), "private, no-store");
		await bucket.put("v0.6.1-tam.1/private.env", "must-not-be-public");
		assert.equal(
			(
				await mf.dispatchFetch(
					"https://cap.example/downloads/v0.6.1-tam.1/private.env",
				)
			).status,
			404,
		);
		assert.equal(
			(await mf.dispatchFetch(request.url, { method: "POST" })).status,
			405,
		);
		assert.equal(
			(
				await mf.dispatchFetch(
					"https://cap.example/downloads/v0.6.1/TAMCap-Windows-x64-setup.exe",
				)
			).status,
			404,
		);
	} finally {
		await mf.dispose();
	}
});
