import { createHash, timingSafeEqual } from "node:crypto";
import { analyticsDatabase } from "@cap/database/cloudflare/analytics/application";
import {
	ANALYTICS_RETENTION_DAYS,
	createAnalyticsRepository,
} from "@cap/database/cloudflare/analytics/repository";
import { serverEnv } from "@cap/env";

export async function GET(request: Request) {
	const secret = process.env.CRON_SECRET;
	if (!secret)
		return Response.json({ error: "Server misconfiguration" }, { status: 500 });
	const supplied = request.headers.get("authorization");
	const digest = (value: string) => createHash("sha256").update(value).digest();
	if (
		!supplied ||
		!timingSafeEqual(digest(supplied), digest(`Bearer ${secret}`))
	)
		return Response.json({ error: "Unauthorized" }, { status: 401 });
	const deleted = await createAnalyticsRepository(
		analyticsDatabase(),
		serverEnv().NEXTAUTH_SECRET,
	).cleanup();
	return Response.json({
		success: true,
		deleted,
		retentionDays: ANALYTICS_RETENTION_DAYS,
	});
}
