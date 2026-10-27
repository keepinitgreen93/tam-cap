import { createHash, timingSafeEqual } from "node:crypto";
import { db } from "@cap/database/cloudflare/application";
import { developerApps } from "@cap/database/cloudflare/schema";
import { buildEnv } from "@cap/env";
import { and, asc, gt, isNull } from "drizzle-orm";
import { NextResponse } from "next/server";
import { recordDeveloperStorageDay } from "@/lib/developer-usage";

export async function GET(request: Request) {
	const secret = process.env.CRON_SECRET;
	if (!secret)
		return NextResponse.json(
			{ error: "Server misconfiguration" },
			{ status: 500 },
		);
	const header = request.headers.get("authorization");
	const digest = (value: string) => createHash("sha256").update(value).digest();
	if (!header || !timingSafeEqual(digest(header), digest(`Bearer ${secret}`)))
		return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
	const today = new Date().toISOString().slice(0, 10);
	const database = db();
	let cursor: string | undefined;
	let processed = 0;
	while (true) {
		const apps = await database
			.select({ id: developerApps.id })
			.from(developerApps)
			.where(
				and(
					isNull(developerApps.deletedAt),
					cursor ? gt(developerApps.id, cursor) : undefined,
				),
			)
			.orderBy(asc(developerApps.id))
			.limit(50);
		if (apps.length === 0) break;
		for (let offset = 0; offset < apps.length; offset += 4) {
			const results = await Promise.allSettled(
				apps
					.slice(offset, offset + 4)
					.map((app) =>
						recordDeveloperStorageDay(
							database,
							app.id,
							today,
							buildEnv.NEXT_PUBLIC_IS_CAP === "true",
						),
					),
			);
			for (const result of results) {
				if (result.status === "fulfilled" && result.value) processed++;
				else if (result.status === "rejected")
					console.error(
						"Failed to record developer storage usage",
						result.reason,
					);
			}
		}
		cursor = apps.at(-1)?.id;
		if (!cursor || apps.length < 50) break;
	}
	return NextResponse.json({
		success: true,
		date: today,
		appsProcessed: processed,
	});
}
