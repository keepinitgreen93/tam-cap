import { Container, getContainer } from "@cloudflare/containers";
import { handleD1BridgeRequest } from "../../packages/database/cloudflare/bridge";
import {
	decode,
	encode,
} from "../../packages/workflow-cloudflare/transport.mjs";
import { runMaintenance } from "./maintenance";
import { applicationHeaders } from "./request-headers";
import { webEnvironment } from "./runtime-env";

export { ContainerProxy } from "@cloudflare/containers";
export { CapWorkflowStore } from "./workflow-store.mjs";

interface RuntimeBindings {
	DB: D1Database;
	ANALYTICS_DB: D1Database;
	CAP_WEB: DurableObjectNamespace<CapWeb>;
	CAP_MEDIA: DurableObjectNamespace<CapMedia>;
	CAP_WORKFLOW: DurableObjectNamespace;
	CAP_WEB_ENV: string;
	MEDIA_SERVER_WEBHOOK_SECRET: string;
	CAP_RUNTIME_READY: string;
	CAP_DEPLOYMENT_ID: string;
	CAP_MAINTENANCE_ENABLED?: string;
	WORKFLOW_QUEUE: Queue<unknown>;
	CAP_PREVIEW_KEY?: string;
}

function hasPreviewAccess(request: Request, configuredKey: string | undefined) {
	const suppliedKey = request.headers.get("x-cap-preview-key");
	if (!configuredKey || !suppliedKey) return false;
	const encoder = new TextEncoder();
	const expected = encoder.encode(configuredKey);
	const supplied = encoder.encode(suppliedKey);
	return (
		expected.length === supplied.length &&
		crypto.subtle.timingSafeEqual(expected, supplied)
	);
}

class CapContainer extends Container<RuntimeBindings> {
	instance: "standard-1" | "standard-2" = "standard-1";
	private starting?: Promise<void>;

	async fetch(request: Request): Promise<Response> {
		const container = this.ctx.container;
		if (!container) throw new Error("Container binding is unavailable");
		if (!container.running) {
			this.starting ??= (async () => {
				await this.setOutboundByHosts({});
				if (!container.running) {
					container.start({
						image: container.images.base,
						instance: this.instance,
						enableInternet: true,
						env: this.envVars,
					});
				}
			})();
			try {
				await this.starting;
			} finally {
				this.starting = undefined;
			}
		}
		return super.fetch(request);
	}
}

export class CapWeb extends CapContainer {
	defaultPort = 3000;
	sleepAfter = "2m";
	envVars = webEnvironment(
		this.env.CAP_WEB_ENV,
		this.env.MEDIA_SERVER_WEBHOOK_SECRET,
	);
}

async function workflowRpc(
	env: RuntimeBindings,
	method: string,
	args: unknown[],
) {
	const response = await env.CAP_WORKFLOW.getByName("primary").fetch(
		new Request("http://cap.workflow/rpc", {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ method, args: encode(args) }),
		}),
	);
	if (!response.ok) throw new Error("Workflow persistence unavailable");
	const result = (await response.json()) as { value: unknown };
	return decode(result.value);
}

export class CapMedia extends CapContainer {
	defaultPort = 3456;
	sleepAfter = "5m";
	envVars = {
		MEDIA_SERVER_WEBHOOK_SECRET: this.env.MEDIA_SERVER_WEBHOOK_SECRET,
		MEDIA_SERVER_MAX_CONCURRENT_VIDEO_PROCESSES: "1",
		MEDIA_SERVER_MAX_CONCURRENT_DIRECT_CONVERSIONS: "1",
	};

	async onActivityExpired() {
		if (!this.ctx.container?.running) return;
		const response = await this.containerFetch("http://localhost/health", {
			headers: {
				"x-media-server-secret": this.env.MEDIA_SERVER_WEBHOOK_SECRET,
			},
		});
		const health = (await response.json()) as {
			runtime?: {
				activeJobs: number;
				activeSubprocesses: number;
				backgroundTasks: number;
				inFlightRequests: number;
			};
		};
		if (
			!response.ok ||
			!health.runtime ||
			health.runtime.activeJobs > 0 ||
			health.runtime.activeSubprocesses > 0 ||
			health.runtime.backgroundTasks > 0 ||
			health.runtime.inFlightRequests > 0
		)
			this.renewActivityTimeout();
		else await this.stop();
	}
}

CapWeb.outboundByHost = {
	"cap.database": (request, env: RuntimeBindings) =>
		handleD1BridgeRequest(request, env.DB),
	"cap.analytics": (request, env: RuntimeBindings) =>
		handleD1BridgeRequest(request, env.ANALYTICS_DB),
	"cap.workflow": (request, env: RuntimeBindings) =>
		env.CAP_WORKFLOW.getByName("primary").fetch(request),
	"cap.media": (request, env: RuntimeBindings) =>
		getContainer(env.CAP_MEDIA, "primary").fetch(request),
};

CapMedia.outboundByHost = {
	"cap.web": (request, env: RuntimeBindings) =>
		getContainer(env.CAP_WEB, "primary").fetch(request),
};

export default {
	async fetch(request: Request, env: RuntimeBindings) {
		let path: string;
		try {
			const decoded = decodeURIComponent(new URL(request.url).pathname).replace(
				/[/\\]+/g,
				"/",
			);
			path = new URL(decoded, "https://cap.internal").pathname;
		} catch {
			return new Response("Invalid path", { status: 400 });
		}
		if (
			["/.well-known/workflow", "/query", "/rpc", "/api/cron"].some(
				(prefix) => path === prefix || path.startsWith(`${prefix}/`),
			)
		) {
			return new Response("Not found", { status: 404 });
		}
		const isPreview = env.CAP_RUNTIME_READY !== "true";
		if (isPreview && !hasPreviewAccess(request, env.CAP_PREVIEW_KEY)) {
			return new Response("Application deployment is not ready", {
				status: 503,
				headers: { "Cache-Control": "no-store" },
			});
		}
		const headers = applicationHeaders(request, request.cf);
		const response = await getContainer(env.CAP_WEB, "primary").fetch(
			new Request(request, { headers }),
		);
		if (!isPreview) return response;
		const previewResponse = new Response(response.body, response);
		previewResponse.headers.set("Cache-Control", "private, no-store");
		return previewResponse;
	},
	async scheduled(event: ScheduledController, env: RuntimeBindings) {
		if (env.CAP_MAINTENANCE_ENABLED !== "true") return;
		await env.WORKFLOW_QUEUE.send({
			kind: "maintenance",
			scheduledTime: event.scheduledTime,
		});
	},
	async queue(batch: MessageBatch<unknown>, env: RuntimeBindings) {
		for (const message of batch.messages) {
			try {
				const maintenance = message.body as {
					kind?: unknown;
					scheduledTime?: unknown;
				} | null;
				if (maintenance?.kind === "maintenance") {
					if (env.CAP_MAINTENANCE_ENABLED !== "true") {
						message.retry({ delaySeconds: 900 });
						continue;
					}
					if (typeof maintenance.scheduledTime !== "number")
						throw new Error("Invalid maintenance message");
					await runMaintenance(
						maintenance.scheduledTime,
						env.CAP_WEB_ENV,
						(request) => getContainer(env.CAP_WEB, "primary").fetch(request),
					);
					message.ack();
					continue;
				}
				const pointer = message.body as { messageId: string };
				const envelope = await workflowRpc(env, "delivery.get", [
					pointer.messageId,
				]);
				if (!envelope) {
					message.ack();
					continue;
				}
				const kind = envelope.queueName.includes("_wkf_step_")
					? "step"
					: "flow";
				const response = await getContainer(env.CAP_WEB, "primary").fetch(
					new Request(`http://cap.web/.well-known/workflow/v1/${kind}`, {
						method: "POST",
						headers: { "Content-Type": "application/json" },
						body: JSON.stringify(
							encode({ ...envelope, attempt: message.attempts }),
						),
					}),
				);
				if (!response.ok) {
					message.retry({ delaySeconds: 30 });
					continue;
				}
				message.ack();
			} catch {
				message.retry({ delaySeconds: 30 });
			}
		}
	},
};
