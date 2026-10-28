export function webEnvironment(serialized: string, mediaSecret: string) {
	const value: unknown = JSON.parse(serialized);
	if (!value || typeof value !== "object" || Array.isArray(value)) {
		throw new Error("CAP_WEB_ENV must contain an environment object");
	}
	const env: Record<string, string> = {};
	for (const [key, entry] of Object.entries(value)) {
		if (typeof entry !== "string")
			throw new Error(`Invalid environment value: ${key}`);
		env[key] = entry;
	}
	for (const key of ["WEB_URL", "NEXTAUTH_URL", "NEXTAUTH_SECRET"]) {
		if (!env[key]) throw new Error(`Missing required environment key: ${key}`);
	}
	if (
		env.WEB_URL !== env.NEXTAUTH_URL ||
		new URL(env.WEB_URL).protocol !== "https:"
	) {
		throw new Error(
			"WEB_URL and NEXTAUTH_URL must identify the same HTTPS origin",
		);
	}
	if (!mediaSecret)
		throw new Error("Missing media server authentication secret");
	delete env.NEXT_PUBLIC_IS_CAP;
	return {
		...env,
		CAP_RUNTIME: "cloudflare",
		DATABASE_PROVIDER: "d1",
		D1_BRIDGE_URL: "http://cap.database/query",
		ANALYTICS_D1_BRIDGE_URL: "http://cap.analytics/query",
		WORKFLOW_TARGET_WORLD: "@cap/workflow-cloudflare",
		CAP_WORKFLOW_URL: "http://cap.workflow/rpc",
		MEDIA_SERVER_URL: "http://cap.media",
		MEDIA_SERVER_WEBHOOK_URL: "http://cap.web",
		MEDIA_SERVER_WEBHOOK_SECRET: mediaSecret,
	};
}
export interface WebConfigurationEnvironment {
	CAP_WEB_ENV: string;
	MEDIA_SERVER_WEBHOOK_SECRET: string;
	CAP_WEB_IMAGE_REVISION?: string;
	CAP_DEPLOYMENT_ID?: string;
	CF_VERSION_METADATA?: WorkerVersionMetadata;
}

export const WEB_CONFIGURATION_HEADER = "x-cap-runtime-web-config";
export const WEB_VERSION_HEADER = "x-cap-runtime-worker-version";

export function workerVersionTimestamp(value: unknown): bigint | undefined {
	if (typeof value !== "string") return undefined;
	const match =
		/^(\d{4}-\d{2}-\d{2})T(?:[01]\d|2[0-3]):[0-5]\d:[0-5]\d(?:\.(\d{1,9}))?(?:Z|[+-](?:[01]\d|2[0-3]):[0-5]\d)$/.exec(
			value,
		);
	const milliseconds = Date.parse(value);
	if (!match || !Number.isFinite(milliseconds)) return undefined;
	if (
		new Date(`${match[1]}T00:00:00.000Z`).toISOString().slice(0, 10) !==
		match[1]
	)
		return undefined;
	return (
		BigInt(milliseconds) * 1_000_000n +
		BigInt((match[2] ?? "").slice(3).padEnd(6, "0"))
	);
}

export function configurationUpdatingResponse() {
	return new Response("Application configuration is updating", {
		status: 503,
		headers: { "Cache-Control": "no-store", "Retry-After": "1" },
	});
}

export async function webConfigurationFingerprint(
	env: WebConfigurationEnvironment,
) {
	const serialized = JSON.stringify({
		version: 2,
		envVars: Object.entries(
			webEnvironment(env.CAP_WEB_ENV, env.MEDIA_SERVER_WEBHOOK_SECRET),
		).sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0)),
		imageRevision: env.CAP_WEB_IMAGE_REVISION ?? "",
		deploymentId: env.CAP_DEPLOYMENT_ID,
	});
	const digest = await crypto.subtle.digest(
		"SHA-256",
		new TextEncoder().encode(serialized),
	);
	return Array.from(new Uint8Array(digest), (value) =>
		value.toString(16).padStart(2, "0"),
	).join("");
}

export async function webConfigurationRequest(
	request: Request,
	env: WebConfigurationEnvironment,
) {
	const headers = new Headers(request.headers);
	headers.set(WEB_CONFIGURATION_HEADER, await webConfigurationFingerprint(env));
	headers.delete(WEB_VERSION_HEADER);
	const timestamp = env.CF_VERSION_METADATA?.timestamp;
	if (
		workerVersionTimestamp(timestamp) !== undefined &&
		timestamp !== undefined
	)
		headers.set(WEB_VERSION_HEADER, timestamp);
	return new Request(request, { headers });
}
