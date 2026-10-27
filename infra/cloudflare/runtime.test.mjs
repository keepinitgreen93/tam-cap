import assert from "node:assert/strict";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";
import { Miniflare } from "miniflare";
import { webEnvironment } from "./runtime-env.ts";

test("container environment fixes private providers and preserves self-hosted mode", () => {
	const env = webEnvironment(
		JSON.stringify({
			WEB_URL: "https://cap.example",
			NEXTAUTH_URL: "https://cap.example",
			NEXTAUTH_SECRET: "test-secret",
			NEXT_PUBLIC_IS_CAP: "true",
			DATABASE_PROVIDER: "mysql",
			WORKFLOW_TARGET_WORLD: "local",
		}),
		"media-secret",
	);
	assert.equal(env.CAP_RUNTIME, "cloudflare");
	assert.equal(env.DATABASE_PROVIDER, "d1");
	assert.equal(env.WORKFLOW_TARGET_WORLD, "@cap/workflow-cloudflare");
	assert.equal(env.NEXT_PUBLIC_IS_CAP, undefined);
	assert.equal(env.D1_BRIDGE_URL, "http://cap.database/query");
	assert.equal(env.MEDIA_SERVER_URL, "http://cap.media");
});

test("container refuses incomplete or inconsistent environment", () => {
	for (const env of [
		{},
		[],
		{
			WEB_URL: "http://cap.example",
			NEXTAUTH_URL: "http://cap.example",
			NEXTAUTH_SECRET: "test",
		},
		{
			WEB_URL: "https://cap.example",
			NEXTAUTH_URL: "https://other.example",
			NEXTAUTH_SECRET: "test",
		},
	]) {
		assert.throws(() => webEnvironment(JSON.stringify(env), "media-secret"));
	}
});

test("runtime staging remains closed and never exposes workflow or database control paths", async () => {
	const bundle = await build({
		entryPoints: [
			fileURLToPath(new URL("./runtime-worker.ts", import.meta.url)),
		],
		bundle: true,
		write: false,
		format: "esm",
		platform: "node",
		external: ["cloudflare:workers"],
	});
	const mf = new Miniflare({
		modules: true,
		script: bundle.outputFiles[0].text,
		compatibilityDate: "2026-04-01",
		compatibilityFlags: ["nodejs_compat"],
		bindings: { CAP_RUNTIME_READY: "false" },
	});
	try {
		for (const path of ["/", "/login", "/dashboard"]) {
			assert.equal(
				(await mf.dispatchFetch(`https://cap.example${path}`)).status,
				503,
			);
		}
		for (const path of [
			"/query",
			"/rpc",
			"/.well-known/workflow/v1/step",
			"/%2ewell-known/workflow/v1/flow",
			"/.well-known%2fworkflow/v1/step",
		]) {
			assert.equal(
				(
					await mf.dispatchFetch(`https://cap.example${path}`, {
						method: "POST",
					})
				).status,
				404,
			);
		}
	} finally {
		await mf.dispose();
	}
});

test("named-image startup coalesces concurrent requests and configures private egress first", async () => {
	const bundle = await build({
		stdin: {
			contents: 'export { CapWeb } from "./runtime-worker.ts";',
			resolveDir: import.meta.dirname,
		},
		bundle: true,
		write: false,
		format: "esm",
		platform: "node",
		plugins: [
			{
				name: "container-contract",
				setup(build) {
					build.onResolve(
						{ filter: /^(@cloudflare\/containers|cloudflare:workers)$/ },
						(args) => ({ path: args.path, namespace: "container-contract" }),
					);
					build.onLoad(
						{ filter: /.*/, namespace: "container-contract" },
						() => ({
							contents: `export class Container { constructor(ctx,env){this.ctx=ctx;this.env=env;} async setOutboundByHosts(){await this.ctx.configure();} async fetch(){return new Response("ready");} } export class ContainerProxy{} export class DurableObject{} export function getContainer(){throw new Error("Unexpected routing");}`,
						}),
					);
				},
			},
		],
	});
	const { CapWeb } = await import(
		`data:text/javascript;base64,${Buffer.from(bundle.outputFiles[0].text).toString("base64")}`
	);
	const events = [];
	let configured;
	const configuration = new Promise((resolve) => {
		configured = resolve;
	});
	const container = {
		running: false,
		images: { base: "registry.test/image@sha256:pinned" },
		start(options) {
			events.push(options);
			this.running = true;
		},
	};
	const app = new CapWeb(
		{ container, configure: () => configuration },
		{
			CAP_WEB_ENV: JSON.stringify({
				WEB_URL: "https://cap.example",
				NEXTAUTH_URL: "https://cap.example",
				NEXTAUTH_SECRET: "test",
			}),
			MEDIA_SERVER_WEBHOOK_SECRET: "media-secret",
		},
	);
	const requests = [
		app.fetch(new Request("https://cap.example/a")),
		app.fetch(new Request("https://cap.example/b")),
	];
	assert.equal(events.length, 0);
	configured();
	assert.deepEqual(
		(await Promise.all(requests)).map((response) => response.status),
		[200, 200],
	);
	assert.equal(events.length, 1);
	assert.equal(events[0].image, container.images.base);
	assert.equal(events[0].instance, "standard-1");
	assert.equal(events[0].env.DATABASE_PROVIDER, "d1");
});

test("preview key gates staging, is stripped, and cannot open internal control paths", async () => {
	const bundle = await build({
		stdin: {
			contents: `import { DurableObject } from "cloudflare:workers";
import runtime from "./runtime-worker.ts";
export class PreviewWeb extends DurableObject {
fetch(request) { return Response.json({ path:new URL(request.url).pathname, preview:request.headers.get("x-cap-preview-key"), cookie:request.headers.get("cookie"), authorization:request.headers.get("authorization") }); }
}
export default runtime;`,
			resolveDir: import.meta.dirname,
		},
		bundle: true,
		write: false,
		format: "esm",
		platform: "node",
		external: ["cloudflare:workers"],
	});
	for (const configuredKey of [undefined, "", "test-preview-key"]) {
		const mf = new Miniflare({
			modules: true,
			script: bundle.outputFiles[0].text,
			compatibilityDate: "2026-04-01",
			compatibilityFlags: ["nodejs_compat"],
			durableObjects: { CAP_WEB: { className: "PreviewWeb", useSQLite: true } },
			bindings: {
				CAP_RUNTIME_READY: "false",
				...(configuredKey === undefined
					? {}
					: { CAP_PREVIEW_KEY: configuredKey }),
			},
		});
		try {
			for (const supplied of [undefined, "", "wrong-key", "test-preview-key"]) {
				const headers = new Headers({
					cookie: "next-auth.session-token=test-session",
				});
				if (supplied !== undefined) headers.set("x-cap-preview-key", supplied);
				const response = await mf.dispatchFetch("https://cap.example/login", {
					headers,
				});
				if (configuredKey && supplied === configuredKey) {
					assert.equal(response.status, 200);
					assert.deepEqual(await response.json(), {
						path: "/login",
						preview: null,
						cookie: "next-auth.session-token=test-session",
						authorization: null,
					});
					assert.equal(
						response.headers.get("Cache-Control"),
						"private, no-store",
					);
				} else assert.equal(response.status, 503);
			}
			for (const path of [
				"/query",
				"/rpc",
				"/%72pc",
				"/%2ewell-known/workflow/v1/flow",
				"/.well-known%2fworkflow/v1/step",
				"/%2e%2f.well-known/workflow/v1/step",
				"/%5c.well-known%5cworkflow/v1/flow",
				"/rpc%2f",
			]) {
				assert.equal(
					(
						await mf.dispatchFetch(`https://cap.example${path}`, {
							method: "POST",
							headers: { "x-cap-preview-key": "test-preview-key" },
						})
					).status,
					404,
				);
			}
		} finally {
			await mf.dispose();
		}
	}
});
