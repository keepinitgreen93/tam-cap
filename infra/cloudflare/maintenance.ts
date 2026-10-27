export function maintenancePaths(scheduledTime: number) {
	const date = new Date(scheduledTime);
	if (!Number.isFinite(date.getTime()))
		throw new Error("Invalid maintenance time");
	const paths = [
		"/api/cron/finalize-stale-desktop-segments",
		"/api/cron/recover-failed-video-processing",
	];
	if (date.getUTCHours() === 3 && date.getUTCMinutes() === 0) {
		paths.push(
			"/api/cron/cleanup-agent-api",
			"/api/cron/developer-storage",
			"/api/cron/analytics-cleanup",
		);
	}
	return paths;
}

export async function runMaintenance(
	scheduledTime: number,
	serializedEnvironment: string,
	fetchInternal: (request: Request) => Promise<Response>,
) {
	const env = JSON.parse(serializedEnvironment);
	if (!env || typeof env.CRON_SECRET !== "string" || !env.CRON_SECRET)
		throw new Error("Maintenance credential is not configured");
	const failures: string[] = [];
	for (const path of maintenancePaths(scheduledTime)) {
		try {
			const response = await fetchInternal(
				new Request(`http://cap.web${path}`, {
					headers: { authorization: `Bearer ${env.CRON_SECRET}` },
					redirect: "error",
					signal: AbortSignal.timeout(60_000),
				}),
			);
			if (!response.ok) failures.push(`${path}:${response.status}`);
			await response.body?.cancel();
		} catch {
			failures.push(`${path}:unavailable`);
		}
	}
	if (failures.length)
		throw new Error(`Maintenance incomplete: ${failures.join(", ")}`);
}
