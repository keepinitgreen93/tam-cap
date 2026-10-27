import { db } from "@cap/database/cloudflare/application";
import { atomic } from "@cap/database/cloudflare/atomic";
import {
	developerApps,
	developerCreditAccounts,
	developerVideos,
} from "@cap/database/cloudflare/schema";
import { nanoId } from "@cap/database/helpers";
import { buildEnv } from "@cap/env";
import { zValidator } from "@hono/zod-validator";
import { and, eq, isNull } from "drizzle-orm";
import { Hono } from "hono";
import { z } from "zod";
import { withDeveloperPublicAuth } from "../../../../utils";

const MIN_BALANCE_MICRO_CREDITS = 5_000;

export const app = new Hono<{
	Variables: {
		developerAppId: string;
		developerKeyType: "public";
	};
}>().use(withDeveloperPublicAuth);

app.post(
	"/create",
	zValidator(
		"json",
		z.object({
			name: z.string().max(255).optional(),
			userId: z.string().max(255).optional(),
			metadata: z
				.record(z.unknown())
				.optional()
				.refine(
					(val) => val === undefined || JSON.stringify(val).length <= 8192,
					{ message: "Metadata must be under 8KB" },
				),
		}),
	),
	async (c) => {
		const appId = c.get("developerAppId");
		const body = c.req.valid("json");

		const videoId = nanoId();
		const s3Key = `developer/${appId}/${videoId}/video`;
		const database = db();
		const created = await atomic(database, async (snapshot) => {
			const [activeApp] = await snapshot.read((reader) =>
				reader
					.select({ id: developerApps.id })
					.from(developerApps)
					.where(
						and(eq(developerApps.id, appId), isNull(developerApps.deletedAt)),
					)
					.limit(1),
			);
			if (!activeApp) return { statements: [], result: false };
			const [account] = await snapshot.read((reader) =>
				reader
					.select({
						balanceMicroCredits: developerCreditAccounts.balanceMicroCredits,
					})
					.from(developerCreditAccounts)
					.where(eq(developerCreditAccounts.appId, appId))
					.limit(1),
			);
			if (
				buildEnv.NEXT_PUBLIC_IS_CAP === "true" &&
				(!account || account.balanceMicroCredits < MIN_BALANCE_MICRO_CREDITS)
			)
				return { statements: [], result: false };
			return {
				statements: [
					database
						.insert(developerVideos)
						.values({
							id: videoId,
							appId,
							externalUserId: body.userId,
							name: body.name ?? "Untitled",
							s3Key,
							metadata: body.metadata,
						}),
				],
				result: true,
			};
		});
		if (!created)
			return c.json(
				{
					error:
						buildEnv.NEXT_PUBLIC_IS_CAP === "true"
							? "Insufficient credits"
							: "App unavailable",
				},
				buildEnv.NEXT_PUBLIC_IS_CAP === "true" ? 402 : 404,
			);

		const webUrl = buildEnv.NEXT_PUBLIC_WEB_URL;

		return c.json({
			videoId,
			s3Key,
			shareUrl: `${webUrl}/dev/${videoId}`,
			embedUrl: `${webUrl}/embed/${videoId}?sdk=1`,
		});
	},
);
