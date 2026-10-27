import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { applySwcTransform } from "@workflow/builders";
import { build } from "esbuild";
import { Miniflare } from "miniflare";
import { ulid } from "ulid";
import { start } from "workflow/api";
import { registerStepFunction } from "workflow/internal/private";
import { setWorld, workflowEntrypoint } from "workflow/runtime";
import { createWorld } from "../../packages/workflow-cloudflare/index.mjs";
import {
	decode,
	encode,
} from "../../packages/workflow-cloudflare/transport.mjs";

const bundle = await build({
	stdin: {
		contents: `import { CapWorkflowStore } from "./workflow-store.mjs";
import { encode } from "../../packages/workflow-cloudflare/transport.mjs";
export class TestStore extends CapWorkflowStore {
async fetch(request) {
if (new URL(request.url).pathname === "/inspect") return Response.json({ outbox: (await this.ctx.storage.list({prefix:"outbox:"})).size, alarm: await this.ctx.storage.getAlarm() });
if (new URL(request.url).pathname === "/deliveries") return Response.json(encode(Array.from((await this.ctx.storage.list({prefix:"delivery:"})).values())));
if (new URL(request.url).pathname === "/expire") { const key = "delivery:" + request.headers.get("id"); const item = await this.ctx.storage.get(key); await this.ctx.storage.put(key, {...item, leaseUntil:0}); return new Response("ok"); }
if (request.headers.has("x-fail-index")) {
const storage=this.ctx.storage;
const transaction=storage.transaction.bind(storage);
Object.defineProperty(storage,"transaction",{configurable:true,value:(callback)=>transaction((txn)=>callback(new Proxy(txn,{get(target,key){if(key==="put")return (name,value)=>{if(name.startsWith("index:"))throw new Error("Injected index failure");return target.put(name,value)};const value=Reflect.get(target,key,target);return typeof value==="function"?value.bind(target):value}})))});
try { return await super.fetch(request); } finally { delete storage.transaction; }
}
return super.fetch(request);
}
}
export default { fetch(request, env) { return env.STORE.getByName("primary").fetch(request); } };`,
		resolveDir: import.meta.dirname,
	},
	bundle: true,
	write: false,
	format: "esm",
	platform: "node",
	external: ["cloudflare:workers"],
});

function openStore(persist) {
	const mf = new Miniflare({
		modules: true,
		script: bundle.outputFiles[0].text,
		compatibilityDate: "2026-04-01",
		compatibilityFlags: ["nodejs_compat"],
		durableObjects: { STORE: { className: "TestStore", useSQLite: true } },
		durableObjectsPersist: persist,
		bindings: { CAP_DEPLOYMENT_ID: "test-build" },
		queueProducers: { WORKFLOW_QUEUE: "test-queue" },
	});
	return {
		mf,
		world: createWorld({
			fetch: async (url, init) => {
				const response = await mf.dispatchFetch(url, init);
				if (!response.headers.get("content-type")?.includes("json"))
					console.error(await response.clone().text());
				return response;
			},
		}),
	};
}

async function createRun(world) {
	const id = `wrun_${ulid()}`;
	await world.events.create(id, {
		eventType: "run_created",
		specVersion: 3,
		eventData: {
			deploymentId: "test-build",
			workflowName: "test",
			input: ["original"],
		},
	});
	await world.events.create(id, { eventType: "run_started", specVersion: 3 });
	return id;
}

test("transport preserves binary, dates, undefined and literal tag-shaped input", () => {
	const input = {
		bytes: new Uint8Array([0, 255]),
		date: new Date(),
		empty: undefined,
		nested: ["date", "text"],
		big: 2n,
	};
	assert.deepEqual(decode(JSON.parse(JSON.stringify(encode(input)))), input);
});

test("workflow state and hook index survive a runtime restart", async () => {
	const persist = await mkdtemp(join(tmpdir(), "cap-world-"));
	let runtime = openStore(persist);
	let id;
	try {
		id = await createRun(runtime.world);
		await runtime.world.events.create(id, {
			eventType: "hook_created",
			correlationId: `hook_${ulid()}`,
			specVersion: 3,
			eventData: { token: "restart-hook" },
		});
	} finally {
		await runtime.mf.dispose();
	}
	runtime = openStore(persist);
	try {
		assert.equal((await runtime.world.runs.get(id)).status, "running");
		assert.equal(
			(await runtime.world.hooks.getByToken("restart-hook")).runId,
			id,
		);
		assert.equal(
			(await runtime.world.events.list({ runId: id })).data.length,
			3,
		);
	} finally {
		await runtime.mf.dispose();
	}
});

test("concurrent runs cannot claim the same hook token", async () => {
	const runtime = openStore(await mkdtemp(join(tmpdir(), "cap-world-")));
	try {
		const ids = await Promise.all([
			createRun(runtime.world),
			createRun(runtime.world),
		]);
		const results = await Promise.allSettled(
			ids.map((id) =>
				runtime.world.events.create(id, {
					eventType: "hook_created",
					correlationId: `hook_${ulid()}`,
					specVersion: 3,
					eventData: { token: "exclusive-hook" },
				}),
			),
		);
		const owner = await runtime.world.hooks.getByToken("exclusive-hook");
		assert.ok(ids.includes(owner.runId));
		const hooks = await Promise.all(
			ids.map((runId) => runtime.world.hooks.list({ runId })),
		);
		assert.equal(
			hooks.reduce((sum, page) => sum + page.data.length, 0),
			1,
		);
		assert.equal(
			results.filter((result) => result.status === "fulfilled").length,
			2,
		);
	} finally {
		await runtime.mf.dispose();
	}
});

test("closed streams read every page and preserve binary bytes", async () => {
	const runtime = openStore(await mkdtemp(join(tmpdir(), "cap-world-")));
	try {
		for (let i = 0; i < 102; i++)
			await runtime.world.writeToStream("stream", "run", new Uint8Array([i]));
		await runtime.world.closeStream("stream", "run");
		const stream = await runtime.world.readFromStream("stream");
		const bytes = new Uint8Array(await new Response(stream).arrayBuffer());
		assert.deepEqual(
			bytes,
			Uint8Array.from({ length: 102 }, (_, index) => index),
		);
	} finally {
		await runtime.mf.dispose();
	}
});

test("queue acceptance persists an outbox entry and alarm", async () => {
	const runtime = openStore(await mkdtemp(join(tmpdir(), "cap-world-")));
	try {
		const result = await runtime.world.queue(
			"__wkf_workflow_test",
			{ runId: `wrun_${ulid()}` },
			{ delaySeconds: 3600 },
		);
		assert.ok(result.messageId.startsWith("msg_"));
		const state = await (
			await runtime.mf.dispatchFetch("http://cap.workflow/inspect")
		).json();
		assert.equal(state.outbox, 1);
		assert.ok(state.alarm);
	} finally {
		await runtime.mf.dispose();
	}
});

test("duplicate delivery cannot execute while leased or after completion", async () => {
	const runtime = openStore(await mkdtemp(join(tmpdir(), "cap-world-")));
	try {
		const message = { runId: `wrun_${ulid()}` };
		const { messageId } = await runtime.world.queue(
			"__wkf_workflow_test",
			message,
			{ delaySeconds: 3600 },
		);
		let finish;
		let entered;
		const running = new Promise((resolve) => {
			entered = resolve;
		});
		const barrier = new Promise((resolve) => {
			finish = resolve;
		});
		let calls = 0;
		const handler = runtime.world.createQueueHandler(
			"__wkf_workflow_",
			async () => {
				calls++;
				entered();
				await barrier;
			},
		);
		const request = () =>
			new Request("http://cap.web/flow", {
				method: "POST",
				body: JSON.stringify(
					encode({
						queueName: "__wkf_workflow_test",
						message,
						messageId,
						attempt: 1,
					}),
				),
			});
		const first = handler(request());
		await running;
		assert.equal((await handler(request())).status, 503);
		finish();
		assert.equal((await first).status, 200);
		assert.equal((await handler(request())).status, 200);
		assert.equal(calls, 1);
	} finally {
		await runtime.mf.dispose();
	}
});

test("expired delivery resumes under a new token and rejects stale completion", async () => {
	const runtime = openStore(await mkdtemp(join(tmpdir(), "cap-world-")));
	try {
		const { messageId } = await runtime.world.queue(
			"__wkf_workflow_test",
			{ runId: `wrun_${ulid()}` },
			{ delaySeconds: 3600 },
		);
		const first = await runtime.world.delivery.claim(messageId);
		await runtime.mf.dispatchFetch("http://cap.workflow/expire", {
			headers: { id: messageId },
		});
		const second = await runtime.world.delivery.claim(messageId);
		assert.notEqual(second.token, first.token);
		assert.deepEqual(
			await runtime.world.delivery.finish(messageId, first.token),
			{ lost: true },
		);
		assert.deepEqual(
			await runtime.world.delivery.finish(messageId, second.token),
			{ completed: true },
		);
	} finally {
		await runtime.mf.dispose();
	}
});

test("deferred delivery is persisted before the original is completed", async () => {
	const runtime = openStore(await mkdtemp(join(tmpdir(), "cap-world-")));
	try {
		const { messageId } = await runtime.world.queue(
			"__wkf_workflow_test",
			{ runId: `wrun_${ulid()}` },
			{ delaySeconds: 3600 },
		);
		const claim = await runtime.world.delivery.claim(messageId);
		await runtime.world.delivery.finish(messageId, claim.token, {
			timeoutSeconds: 7200,
		});
		assert.equal(await runtime.world.delivery.get(messageId), undefined);
		const state = await (
			await runtime.mf.dispatchFetch("http://cap.workflow/inspect")
		).json();
		assert.equal(state.outbox, 2);
	} finally {
		await runtime.mf.dispose();
	}
});

test("an index write failure rolls back the run and every nested event write", async () => {
	const runtime = openStore(await mkdtemp(join(tmpdir(), "cap-world-")));
	try {
		const id = `wrun_${ulid()}`;
		const response = await runtime.mf.dispatchFetch("http://cap.workflow/rpc", {
			method: "POST",
			headers: { "x-fail-index": "1", "Content-Type": "application/json" },
			body: JSON.stringify({
				method: "events.create",
				args: encode([
					id,
					{
						eventType: "run_created",
						specVersion: 3,
						eventData: {
							deploymentId: "test-build",
							workflowName: "test",
							input: [],
						},
					},
				]),
			}),
		});
		assert.equal(response.status, 500);
		await assert.rejects(runtime.world.runs.get(id), {
			name: "WorkflowRunNotFoundError",
		});
		assert.equal(
			(await runtime.world.events.list({ runId: id })).data.length,
			0,
		);
	} finally {
		await runtime.mf.dispose();
	}
});

test("a lost completion response cannot execute the delivery twice", async () => {
	const runtime = openStore(await mkdtemp(join(tmpdir(), "cap-world-")));
	let loseResponse = true;
	const world = createWorld({
		fetch: async (url, init) => {
			const response = await runtime.mf.dispatchFetch(url, init);
			if (JSON.parse(init.body).method === "delivery.finish" && loseResponse) {
				loseResponse = false;
				throw new Error("Injected response loss");
			}
			return response;
		},
	});
	try {
		const message = { runId: `wrun_${ulid()}` };
		const { messageId } = await world.queue("__wkf_workflow_test", message, {
			delaySeconds: 3600,
		});
		let calls = 0;
		const handler = world.createQueueHandler("__wkf_workflow_", async () => {
			calls++;
		});
		const request = () =>
			new Request("http://cap.web/flow", {
				method: "POST",
				body: JSON.stringify(
					encode({
						queueName: "__wkf_workflow_test",
						message,
						messageId,
						attempt: 1,
					}),
				),
			});
		await assert.rejects(handler(request()), /response loss/);
		assert.equal((await handler(request())).status, 200);
		assert.equal(calls, 1);
	} finally {
		await runtime.mf.dispose();
	}
});

test("installed Workflow SDK starts a run through the Cloudflare World contract", async () => {
	const runtime = openStore(await mkdtemp(join(tmpdir(), "cap-world-")));
	try {
		const workflow = Object.assign(async () => {}, {
			workflowId: "workflow//test//sdk-smoke",
		});
		const run = await start(
			workflow,
			["recording", new Uint8Array([1, 2, 3])],
			{ world: runtime.world },
		);
		const stored = await runtime.world.runs.get(run.runId);
		assert.equal(stored.status, "pending");
		assert.equal(stored.workflowName, workflow.workflowId);
		assert.ok(stored.input instanceof Uint8Array);
	} finally {
		await runtime.mf.dispose();
	}
});

test("compiled workflow runs a real SDK step and completes through durable delivery", async () => {
	const runtime = openStore(await mkdtemp(join(tmpdir(), "cap-world-")));
	try {
		setWorld(runtime.world);
		const source = `export async function sample(input) { "use workflow"; return await work(input); } async function work(input) { "use step"; return input + " done"; }`;
		const transformed = await applySwcTransform(
			"cloudflare-world-smoke.ts",
			source,
			"workflow",
		);
		const compiled = await build({
			stdin: { contents: transformed.code, loader: "js" },
			format: "iife",
			banner: { js: "globalThis.__private_workflows = new Map();" },
			write: false,
		});
		const id =
			transformed.workflowManifest.workflows["cloudflare-world-smoke.ts"].sample
				.workflowId;
		const stepId =
			transformed.workflowManifest.steps["cloudflare-world-smoke.ts"].work
				.stepId;
		let calls = 0;
		registerStepFunction(stepId, async (input) => {
			calls++;
			return `${input} done`;
		});
		const workflow = Object.assign(async () => {}, { workflowId: id });
		const run = await start(workflow, ["recording"], { world: runtime.world });
		const flowHandler = workflowEntrypoint(compiled.outputFiles[0].text);
		const { stepEntrypoint } = await import(
			new URL(
				"../../node_modules/@workflow/core/dist/runtime/step-handler.js?cloudflare-test",
				import.meta.url,
			)
		);
		for (let wave = 0; wave < 8; wave++) {
			const deliveries = decode(
				await (
					await runtime.mf.dispatchFetch("http://cap.workflow/deliveries")
				).json(),
			);
			if (!deliveries.length) break;
			for (const envelope of deliveries) {
				const handler = envelope.queueName.includes("_wkf_step_")
					? stepEntrypoint
					: flowHandler;
				const response = await handler(
					new Request("http://cap.web/flow", {
						method: "POST",
						body: JSON.stringify(encode({ ...envelope, attempt: 1 })),
					}),
				);
				assert.equal(response.status, 200, await response.text());
			}
		}
		assert.equal((await runtime.world.runs.get(run.runId)).status, "completed");
		assert.equal(await run.returnValue, "recording done");
		assert.equal(calls, 1);
	} finally {
		setWorld(undefined);
		await runtime.mf.dispose();
	}
});
