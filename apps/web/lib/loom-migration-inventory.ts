import { requireActiveOrganization } from "@cap/database/cloudflare/access";
import { db } from "@cap/database/cloudflare/application";
import { atomic } from "@cap/database/cloudflare/atomic";
import {
	loomMigrationImports,
	loomMigrationRequests,
	videos,
} from "@cap/database/cloudflare/schema";
import { and, eq, isNull, notExists } from "drizzle-orm";
import {
	assertMigrationOperator,
	requireMigrationOperator,
} from "@/lib/loom-concierge";
import { LoomMigrationError } from "@/lib/loom-migration-state";
import { inJsonArray } from "@/utils/sql";

const RECONCILE_BATCH_SIZE = 100;

export async function reconcileMissingLoomMigrationImports({
	requestId,
	verified,
}: {
	requestId: string;
	verified: boolean;
}) {
	const operator = await requireMigrationOperator();
	if (typeof requestId !== "string" || !/^[A-Za-z0-9_-]{15}$/.test(requestId))
		throw new LoomMigrationError("Invalid migration request.");
	if (verified !== true)
		throw new LoomMigrationError(
			"Reconcile deleted recordings against the source list first.",
		);
	const database = db();
	return atomic(database, async (snapshot) => {
		await assertMigrationOperator(snapshot, operator.id);
		const [request] = await snapshot.read((reader) =>
			reader
				.select()
				.from(loomMigrationRequests)
				.where(eq(loomMigrationRequests.id, requestId))
				.limit(1),
		);
		if (
			!request ||
			request.status === "completed" ||
			request.activeOrganizationId !== request.organizationId ||
			(request.activeImportCount > 0 &&
				(!request.activeImportLeaseUntil ||
					request.activeImportLeaseUntil > new Date()))
		)
			throw new LoomMigrationError(
				"The migration is inactive or imports are starting. Refresh and try again.",
			);
		await requireActiveOrganization(snapshot, request.organizationId);
		const missing = await snapshot.read((reader) =>
			reader
				.select({ videoId: loomMigrationImports.videoId })
				.from(loomMigrationImports)
				.leftJoin(videos, eq(videos.id, loomMigrationImports.videoId))
				.where(
					and(eq(loomMigrationImports.requestId, requestId), isNull(videos.id)),
				)
				.limit(RECONCILE_BATCH_SIZE + 1),
		);
		if (missing.length === 0)
			return { statements: [], result: { removedCount: 0, hasMore: false } };
		const selected = missing.slice(0, RECONCILE_BATCH_SIZE);
		const now = new Date();
		return {
			statements: [
				database.delete(loomMigrationImports).where(
					and(
						eq(loomMigrationImports.requestId, requestId),
						inJsonArray(
							loomMigrationImports.videoId,
							selected.map((row) => row.videoId),
						),
						notExists(
							database
								.select({ id: videos.id })
								.from(videos)
								.where(eq(videos.id, loomMigrationImports.videoId)),
						),
					),
				),
				database
					.update(loomMigrationRequests)
					.set({
						lastOperatorUserId: operator.id,
						lastOperatorAt: now,
						updatedAt: now,
					})
					.where(eq(loomMigrationRequests.id, requestId)),
			],
			result: {
				removedCount: selected.length,
				hasMore: missing.length > RECONCILE_BATCH_SIZE,
			},
		};
	});
}
