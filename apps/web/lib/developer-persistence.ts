import { db } from "@cap/database/cloudflare/application";
import { type AtomicStatement, atomic } from "@cap/database/cloudflare/atomic";
import { developerApps } from "@cap/database/cloudflare/schema";
import type { User } from "@cap/web-domain";
import { and, eq, isNull } from "drizzle-orm";

export async function mutateOwnedDeveloperApp(
	userId: User.UserId,
	appId: string,
	statements: (database: ReturnType<typeof db>) => readonly AtomicStatement[],
) {
	const database = db();
	await atomic(database, async (snapshot) => {
		const [app] = await snapshot.read((reader) =>
			reader
				.select({ id: developerApps.id })
				.from(developerApps)
				.where(
					and(
						eq(developerApps.id, appId),
						eq(developerApps.ownerId, userId),
						isNull(developerApps.deletedAt),
					),
				)
				.limit(1),
		);
		if (!app) throw new Error("App not found");
		return { statements: statements(database), result: undefined };
	});
}
