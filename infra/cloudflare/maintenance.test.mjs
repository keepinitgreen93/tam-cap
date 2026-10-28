import assert from "node:assert/strict";
import test from "node:test";
import { build } from "esbuild";
import { maintenancePaths, runMaintenance } from "./maintenance.ts";

test("maintenance schedules recovery every fifteen minutes and cleanup at three UTC", () => {
	const normal = maintenancePaths(Date.parse("2026-10-27T14:15:00Z"));
	assert.equal(normal.length, 2);
	const daily = maintenancePaths(Date.parse("2026-10-27T03:00:00Z"));
	assert.equal(daily.length, 5);
	assert.ok(daily.includes("/api/cron/analytics-cleanup"));
	assert.equal(maintenancePaths(Date.parse("2026-10-27T03:15:00Z")).length, 2);
	assert.throws(() => maintenancePaths(Number.NaN));
});

test("maintenance sends only protected internal requests, consumes bodies, and reports failures without payloads", async () => {
	const requests = [];
	await assert.rejects(
		runMaintenance(
			Date.parse("2026-10-27T03:00:00Z"),
			JSON.stringify({ CRON_SECRET: "test-cron" }),
			async (request) => {
				requests.push(request);
				return new Response("sensitive body that must never appear in errors", {
					status: requests.length === 1 ? 503 : 200,
				});
			},
		),
		(error) => {
			assert.match(error.message, /finalize-stale-desktop-segments:503/);
			assert.doesNotMatch(error.message, /sensitive/);
			return true;
		},
	);
	assert.equal(requests.length, 5);
	for (const request of requests) {
		assert.equal(new URL(request.url).origin, "http://cap.web");
		assert.equal(request.method, "GET");
		assert.equal(request.headers.get("authorization"), "Bearer test-cron");
		assert.equal(request.redirect, "error");
	}
});

test("maintenance fails closed before starting web without a credential", async () => {
	let calls = 0;
	for (const env of ["{}", "[]", '{"CRON_SECRET":42}', "malformed"]) {
		await assert.rejects(
			runMaintenance(Date.now(), env, async () => {
				calls++;
				return new Response();
			}),
		);
	}
	assert.equal(calls, 0);
});

test("scheduled maintenance uses durable queue delivery and retries failed jobs", async () => {
	const bundle = await build({
		stdin: {
			contents: 'export { default } from "./runtime-worker.ts";',
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
							contents:
								"export class Container {} export class ContainerProxy {} export class DurableObject {} export function getContainer(namespace){return namespace;}",
						}),
					);
				},
			},
		],
	});
	const { default: runtime } = await import(
		`data:text/javascript;base64,${Buffer.from(bundle.outputFiles[0].text).toString("base64")}`
	);
	const enqueued = [];
	let healthy = false;
	let calls = 0;
	const env = {
		CAP_MAINTENANCE_ENABLED: "false",
		CAP_WEB_ENV: JSON.stringify({
			CRON_SECRET: "test",
			WEB_URL: "https://cap.example",
			NEXTAUTH_URL: "https://cap.example",
			NEXTAUTH_SECRET: "synthetic-auth-secret",
		}),
		MEDIA_SERVER_WEBHOOK_SECRET: "synthetic-media-secret",
		WORKFLOW_QUEUE: { send: async (message) => enqueued.push(message) },
		CAP_WEB: {
			fetch: async () => {
				calls++;
				return new Response(null, { status: healthy ? 200 : 503 });
			},
		},
	};
	const event = { scheduledTime: Date.parse("2026-10-27T03:00:00Z") };
	await runtime.scheduled(event, env);
	assert.equal(enqueued.length, 0);
	env.CAP_MAINTENANCE_ENABLED = "true";
	await runtime.scheduled(event, env);
	assert.equal(enqueued.length, 1);
	let acks = 0;
	const retries = [];
	const batch = {
		messages: [
			{
				body: enqueued[0],
				ack: () => acks++,
				retry: (options) => retries.push(options),
			},
		],
	};
	await runtime.queue(batch, env);
	assert.equal(acks, 0);
	assert.equal(retries.length, 1);
	assert.equal(calls, 5);
	healthy = true;
	await runtime.queue(batch, env);
	assert.equal(acks, 1);
	assert.equal(calls, 10);
});
