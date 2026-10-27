import { analyticsDatabase } from "@cap/database/cloudflare/analytics/application";
import {
	type AnalyticsDimension,
	type AnalyticsScope,
	type AnalyticsView,
	createAnalyticsRepository,
} from "@cap/database/cloudflare/analytics/repository";
import { serverEnv } from "@cap/env";
import { DatabaseError } from "@cap/web-domain";
import { Effect } from "effect";

export class Analytics extends Effect.Service<Analytics>()("Analytics", {
	sync: () => {
		const repository = () =>
			createAnalyticsRepository(
				analyticsDatabase(),
				serverEnv().NEXTAUTH_SECRET,
			);
		const use = <T>(
			callback: (
				client: ReturnType<typeof createAnalyticsRepository>,
			) => Promise<T>,
		) =>
			Effect.tryPromise({
				try: () => callback(repository()),
				catch: (cause) => new DatabaseError({ cause }),
			});
		return {
			recordView: (input: AnalyticsView) =>
				use((client) => client.recordView(input)),
			countViews: (input: AnalyticsScope) =>
				use((client) => client.countViews(input)),
			viewSeries: (input: AnalyticsScope, bucket: "hour" | "day") =>
				use((client) => client.viewSeries(input, bucket)),
			breakdown: (
				input: AnalyticsScope,
				dimension: AnalyticsDimension,
				limit = 10,
			) => use((client) => client.breakdown(input, dimension, limit)),
			cityBreakdown: (input: AnalyticsScope, limit = 10) =>
				use((client) => client.cityBreakdown(input, limit)),
			topCaps: (input: AnalyticsScope, limit = 10) =>
				use((client) => client.topCaps(input, limit)),
			cleanup: (now?: Date) => use((client) => client.cleanup(now)),
			deleteOrganization: (organizationId: string) =>
				use((client) => client.deleteOrganization(organizationId)),
		};
	},
}) {}
