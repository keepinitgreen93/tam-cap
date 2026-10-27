import { createD1BridgeBinding } from "./bridge.ts";
import { type CloudflareDatabase, createCloudflareDb } from "./index.ts";

let cached: CloudflareDatabase | undefined;

export function db(): CloudflareDatabase {
	if (
		process.env.CAP_RUNTIME !== "cloudflare" ||
		process.env.DATABASE_PROVIDER !== "d1"
	)
		throw new Error(
			"Cloudflare persistence requires CAP_RUNTIME=cloudflare and DATABASE_PROVIDER=d1.",
		);
	cached ??= createCloudflareDb(createD1BridgeBinding());
	return cached;
}
