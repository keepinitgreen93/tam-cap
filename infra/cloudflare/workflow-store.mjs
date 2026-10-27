import { DurableObject } from "cloudflare:workers";
import { createCloudflareWorld } from "@fantasticfour/world-cloudflare";
import {
	StreamDO,
	WorkflowRunDO,
} from "@fantasticfour/world-cloudflare/worker";
import {
	decode,
	encode,
	methods,
} from "../../packages/workflow-cloudflare/transport.mjs";

function scopedStorage(storage, prefix) {
	const scoped = {
		get: (key) => storage.get(prefix + key),
		put: (key, value) => storage.put(prefix + key, value),
		delete: (key) => storage.delete(prefix + key),
		async list(options = {}) {
			const result = await storage.list({
				...options,
				prefix: prefix + (options.prefix ?? ""),
				...(options.start ? { start: prefix + options.start } : {}),
				...(options.startAfter
					? { startAfter: prefix + options.startAfter }
					: {}),
				...(options.end ? { end: prefix + options.end } : {}),
			});
			return new Map(
				Array.from(result, ([key, value]) => [key.slice(prefix.length), value]),
			);
		},
		// Every world operation already owns the outer transaction; nested adapter writes must share its rollback.
		transaction: (callback) => callback(scoped),
	};
	return scoped;
}

function namespace(ctx, storage, Class, prefix, nextUlid) {
	return {
		idFromName: (name) => ({ toString: () => name }),
		get(id) {
			const scoped = scopedStorage(
				storage,
				`${prefix}:${encodeURIComponent(id.toString())}:`,
			);
			const state = new Proxy(ctx, {
				get(target, property) {
					if (property === "storage") return scoped;
					const value = Reflect.get(target, property, target);
					return typeof value === "function" ? value.bind(target) : value;
				},
			});
			const instance = new Class(ctx, {});
			Object.defineProperty(instance, "ctx", { value: state });
			if (nextUlid) instance.nextUlid = nextUlid;
			return instance;
		},
	};
}

function ulidPart(value, length) {
	const alphabet = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
	let result = "";
	for (let index = 0; index < length; index++) {
		result = alphabet[value % 32] + result;
		value = Math.floor(value / 32);
	}
	return result;
}

function indexStorage(storage) {
	const scoped = scopedStorage(storage, "index:");
	return {
		get: async (key) => (await scoped.get(key)) ?? null,
		put: (key, value) => scoped.put(key, value),
		delete: (key) => scoped.delete(key),
		async list(options = {}) {
			const limit = options.limit ?? 1000;
			const result = await scoped.list({
				prefix: options.prefix ?? "",
				limit: limit + 1,
				...(options.cursor ? { startAfter: options.cursor } : {}),
			});
			const names = Array.from(result.keys());
			return {
				keys: names.slice(0, limit).map((name) => ({ name })),
				list_complete: names.length <= limit,
				cursor: names.length > limit ? names[limit - 1] : undefined,
			};
		},
	};
}

export class CapWorkflowStore extends DurableObject {
	async fetch(request) {
		if (request.method !== "POST")
			return new Response("Method not allowed", { status: 405 });
		const text = await request.text();
		if (text.length > 8 * 1024 * 1024)
			return new Response("Too large", { status: 413 });
		try {
			const { method, args: encoded } = JSON.parse(text);
			if (!methods.includes(method))
				return new Response("Unknown operation", { status: 400 });
			const args = decode(encoded);
			const value = await this.ctx.storage.transaction(async (transaction) => {
				if (method === "getDeploymentId") return this.env.CAP_DEPLOYMENT_ID;
				if (method === "queue") return this.enqueue(transaction, ...args);
				if (method === "delivery.get")
					return transaction.get(`delivery:${args[0]}`);
				if (method.startsWith("delivery."))
					return this.delivery(transaction, method, args);
				const clock = (await transaction.get("event-clock")) ?? {
					time: 0,
					sequence: 0,
				};
				let changedClock = false;
				const nextUlid = () => {
					const time = Math.max(Date.now(), clock.time);
					clock.sequence = time === clock.time ? clock.sequence + 1 : 0;
					clock.time = time;
					changedClock = true;
					return ulidPart(time, 10) + ulidPart(clock.sequence, 16);
				};
				const world = createCloudflareWorld({
					deploymentId: this.env.CAP_DEPLOYMENT_ID,
					env: {
						WORKFLOW_DB: namespace(
							this.ctx,
							transaction,
							WorkflowRunDO,
							"run",
							nextUlid,
						),
						WORKFLOW_STREAMS: namespace(
							this.ctx,
							transaction,
							StreamDO,
							"stream",
						),
						WORKFLOW_INDEX: indexStorage(transaction),
						WORKFLOW_QUEUE: {
							send: () => {
								throw new Error("Queue must use durable outbox");
							},
						},
					},
				});
				const [group, name] = method.split(".");
				const result = await (name
					? world[group][name](...args)
					: world[group](...args));
				if (changedClock) await transaction.put("event-clock", clock);
				return result;
			});
			return Response.json({ value: encode(value) });
		} catch (error) {
			return Response.json(
				{
					error: {
						name: error.name,
						message: error.message,
						status: error.status ?? 500,
						code: error.code,
						retryAfter: error.retryAfter,
					},
				},
				{
					status:
						error.status >= 400 && error.status < 600 ? error.status : 500,
				},
			);
		}
	}

	async enqueue(transaction, queueName, message, options = {}) {
		const messageId = `msg_${crypto.randomUUID()}`;
		const dueAt = Date.now() + Math.max(0, options.delaySeconds ?? 0) * 1000;
		await transaction.put(`delivery:${messageId}`, {
			queueName,
			message,
			messageId,
			dueAt,
		});
		await transaction.put(
			`outbox:${String(dueAt).padStart(16, "0")}:${messageId}`,
			{ messageId, dueAt },
		);
		const alarm = await transaction.getAlarm();
		if (alarm === null || dueAt < alarm)
			await transaction.setAlarm(Math.max(Date.now() + 1, dueAt));
		return { messageId };
	}

	async delivery(transaction, method, [messageId, token, result]) {
		const key = `delivery:${messageId}`;
		const item = await transaction.get(key);
		if (!item) return { completed: true };
		if (method === "delivery.claim") {
			if (item.leaseUntil > Date.now()) return { busy: true };
			const next = {
				...item,
				token: crypto.randomUUID(),
				leaseUntil: Date.now() + 60_000,
			};
			await transaction.put(key, next);
			return { token: next.token, leaseUntil: next.leaseUntil };
		}
		if (item.token !== token || item.leaseUntil <= Date.now())
			return { lost: true };
		if (method === "delivery.renew") {
			const leaseUntil = Date.now() + 60_000;
			await transaction.put(key, { ...item, leaseUntil });
			return { renewed: true, leaseUntil };
		}
		if (method === "delivery.release") {
			await transaction.put(key, { ...item, token: undefined, leaseUntil: 0 });
			return { released: true };
		}
		if (method === "delivery.finish") {
			if (result?.timeoutSeconds !== undefined) {
				await this.enqueue(transaction, item.queueName, item.message, {
					delaySeconds: result.timeoutSeconds,
				});
			}
			await transaction.delete(key);
			return { completed: true };
		}
		throw new Error("Unknown delivery operation");
	}

	async alarm() {
		const pending = await this.ctx.storage.list({
			prefix: "outbox:",
			limit: 100,
		});
		let nextAlarm = Infinity;
		for (const [key, item] of pending) {
			if (item.dueAt > Date.now()) {
				nextAlarm = Math.min(nextAlarm, item.dueAt);
				continue;
			}
			try {
				await this.env.WORKFLOW_QUEUE.send({ messageId: item.messageId });
				await this.ctx.storage.delete(key);
			} catch {
				nextAlarm = Math.min(nextAlarm, Date.now() + 30_000);
				break;
			}
		}
		if (
			pending.size === 100 &&
			Array.from(pending.values()).every((item) => item.dueAt <= Date.now())
		)
			nextAlarm = Math.min(nextAlarm, Date.now() + 1000);
		if (Number.isFinite(nextAlarm)) await this.ctx.storage.setAlarm(nextAlarm);
	}
}
