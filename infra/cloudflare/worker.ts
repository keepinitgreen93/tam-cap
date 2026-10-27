interface PlatformBindings {
	DB: {
		prepare(query: string): {
			first<T>(): Promise<T | null>;
		};
	};
	VIDEOS: {
		head(key: string): Promise<unknown>;
	};
}

function response(status: number, healthy: boolean) {
	return Response.json(
		{
			status: healthy ? "ok" : "unavailable",
			component: "cap-cloudflare-platform",
			applicationReady: false,
		},
		{
			status,
			headers: {
				"Cache-Control": "no-store",
				"X-Content-Type-Options": "nosniff",
			},
		},
	);
}

export default {
	async fetch(request: Request, env: PlatformBindings): Promise<Response> {
		if (new URL(request.url).pathname !== "/health") {
			return new Response("Not found", { status: 404 });
		}
		if (request.method !== "GET") {
			return new Response("Method not allowed", {
				status: 405,
				headers: { Allow: "GET" },
			});
		}
		try {
			const [database] = await Promise.all([
				env.DB.prepare("SELECT 1 AS ok").first<{ ok: number }>(),
				env.VIDEOS.head("__platform_readiness_probe__"),
			]);
			return response(database?.ok === 1 ? 200 : 503, database?.ok === 1);
		} catch {
			return response(503, false);
		}
	},
};
