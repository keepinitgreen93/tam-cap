import { createD1BridgeBinding } from "../bridge.ts";
import { type AnalyticsDatabase, createAnalyticsDatabase } from "./index.ts";

let cached: AnalyticsDatabase | undefined;
export function analyticsDatabase() {
	if (process.env.CAP_RUNTIME !== "cloudflare")
		throw new Error("Cloudflare analytics requires the Cloudflare runtime.");
	const url =
		process.env.ANALYTICS_D1_BRIDGE_URL ?? "http://cap.analytics/query";
	if (url !== "http://cap.analytics/query")
		throw new Error("Analytics requires its private database binding.");
	cached ??= createAnalyticsDatabase(createD1BridgeBinding({ url }));
	return cached;
}
