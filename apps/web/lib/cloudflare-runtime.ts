export function validateCloudflareRuntime(
	env: Record<string, string | undefined>,
): boolean {
	if (env.CAP_RUNTIME !== "cloudflare") return false;
	if (env.DATABASE_PROVIDER !== "d1") {
		throw new Error("Cloudflare runtime requires DATABASE_PROVIDER=d1");
	}
	if (env.WORKFLOW_TARGET_WORLD !== "@cap/workflow-cloudflare") {
		throw new Error(
			"Cloudflare runtime requires the durable @cap/workflow-cloudflare adapter",
		);
	}
	if (env.WORKFLOW_LOCAL_DATA_DIR || env.VERCEL === "1") {
		throw new Error(
			"Cloudflare runtime cannot use local or Vercel workflow state",
		);
	}
	return true;
}
