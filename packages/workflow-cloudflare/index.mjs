import * as errors from "@workflow/errors";
import {
	MessageId,
	QueuePayloadSchema,
	SPEC_VERSION_CURRENT,
	ValidQueueName,
} from "@workflow/world";
import { decode, encode, methods } from "./transport.mjs";

export function createWorld(options = {}) {
	const url =
		options.url ?? process.env.CAP_WORKFLOW_URL ?? "http://cap.workflow/rpc";
	const request = options.fetch ?? globalThis.fetch;
	const invoke = async (method, args) => {
		const response = await request(url, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ method, args: encode(args) }),
			signal: AbortSignal.timeout(30_000),
		});
		if (!response.headers.get("content-type")?.includes("application/json")) {
			throw new errors.WorkflowWorldError(
				"Invalid workflow persistence response",
				{ status: response.status },
			);
		}
		const result = await response.json();
		if (!response.ok || result.error) {
			const detail = result.error ?? {};
			const error = new errors.WorkflowWorldError(
				detail.message ?? "Workflow persistence unavailable",
				{
					status: detail.status ?? response.status,
					code: detail.code,
				},
			);
			if (detail.name) error.name = detail.name;
			if (typeof detail.retryAfter === "number")
				error.retryAfter = detail.retryAfter;
			throw error;
		}
		return decode(result.value);
	};
	const world = { specVersion: SPEC_VERSION_CURRENT };
	for (const method of methods) {
		const [group, name] = method.split(".");
		if (name) {
			world[group] ??= {};
			world[group][name] = (...args) => invoke(method, args);
		} else world[group] = (...args) => invoke(method, args);
	}
	world.createQueueHandler = (prefix, handler) => async (request) => {
		const envelope = decode(await request.json());
		const queueName = ValidQueueName.parse(envelope.queueName);
		if (!queueName.startsWith(prefix))
			return new Response("Invalid queue", { status: 400 });
		const messageId = MessageId.parse(envelope.messageId);
		const claim = await invoke("delivery.claim", [messageId]);
		if (claim.completed) return Response.json({});
		if (claim.busy)
			return new Response("Delivery already running", { status: 503 });
		let leaseLost = false;
		let stopped = false;
		let expiry;
		const loseLease = () => {
			if (stopped || leaseLost) return;
			leaseLost = true;
			(options.onLeaseLost ?? (() => process.exit(1)))();
		};
		const renewExpiry = (leaseUntil) => {
			clearTimeout(expiry);
			expiry = setTimeout(
				loseLease,
				Math.max(1, leaseUntil - Date.now() - 1000),
			);
			expiry.unref?.();
		};
		renewExpiry(claim.leaseUntil);
		const heartbeat = setInterval(() => {
			invoke("delivery.renew", [messageId, claim.token])
				.then((result) => {
					if (stopped) return;
					if (!result.renewed) loseLease();
					else renewExpiry(result.leaseUntil);
				})
				.catch(() => {});
		}, 15_000);
		heartbeat.unref?.();
		const stopHeartbeat = () => {
			stopped = true;
			clearInterval(heartbeat);
			clearTimeout(expiry);
		};
		try {
			const result = await handler(QueuePayloadSchema.parse(envelope.message), {
				queueName,
				messageId,
				attempt: envelope.attempt,
			});
			stopHeartbeat();
			if (leaseLost)
				return new Response("Delivery lease lost", { status: 503 });
			const finished = await invoke("delivery.finish", [
				messageId,
				claim.token,
				result,
			]);
			if (!finished.completed)
				return new Response("Delivery lease lost", { status: 503 });
			return Response.json({});
		} catch (error) {
			stopHeartbeat();
			await invoke("delivery.release", [messageId, claim.token]).catch(
				() => {},
			);
			throw error;
		} finally {
			stopHeartbeat();
		}
	};
	world.readFromStream = async (name, startIndex = 0) => {
		let index = startIndex;
		if (index < 0) {
			const info = await world.getStreamInfo(name, "");
			index = Math.max(0, info.tailIndex + 1 + index);
		}
		let cancelled = false;
		return new ReadableStream({
			async pull(controller) {
				while (!cancelled) {
					const page = await world.getStreamChunks(name, "", {
						cursor: String(index),
						limit: 100,
					});
					if (cancelled) return;
					for (const chunk of page.data) {
						controller.enqueue(chunk.data);
						index++;
					}
					if (page.done && !page.hasMore) {
						controller.close();
						return;
					}
					if (page.data.length) return;
					await new Promise((resolve) => setTimeout(resolve, 250));
				}
			},
			cancel() {
				cancelled = true;
			},
		});
	};
	return world;
}

export default createWorld;
