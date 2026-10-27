import "server-only";

import { db } from "@cap/database/cloudflare/application";
import {
	agentApiAuthorizationCodes,
	agentApiIdempotency,
	agentApiKeys,
	agentApiOperations,
} from "@cap/database/cloudflare/schema";
import { and, inArray, lt, or } from "drizzle-orm";

const affectedRows = (result: { meta: { changes: number } }) =>
	result.meta.changes;

const deleteInBatches = async (
	deleteBatch: () => PromiseLike<{ meta: { changes: number } }>,
	batchSize: number,
	maxBatches: number,
) => {
	let deleted = 0;
	for (let batch = 0; batch < maxBatches; batch += 1) {
		const count = affectedRows(await deleteBatch());
		deleted += count;
		if (count < batchSize) break;
	}
	return deleted;
};

export const cleanupExpiredAgentApiRecords = async (input?: {
	now?: Date;
	batchSize?: number;
	maxBatches?: number;
	keyRetentionMs?: number;
	operationRetentionMs?: number;
}) => {
	const now = input?.now ?? new Date();
	const batchSize = Math.min(Math.max(input?.batchSize ?? 1_000, 1), 5_000);
	const maxBatches = Math.min(Math.max(input?.maxBatches ?? 10, 1), 20);
	const keyRetentionMs = Math.max(
		input?.keyRetentionMs ?? 30 * 24 * 60 * 60 * 1_000,
		0,
	);
	const operationRetentionMs = Math.max(
		input?.operationRetentionMs ?? 30 * 24 * 60 * 60 * 1_000,
		0,
	);
	const keyRetentionCutoff = new Date(now.getTime() - keyRetentionMs);
	const operationRetentionCutoff = new Date(
		now.getTime() - operationRetentionMs,
	);
	const database = db();

	const authorizationCodes = await deleteInBatches(
		() =>
			database
				.delete(agentApiAuthorizationCodes)
				.where(
					inArray(
						agentApiAuthorizationCodes.id,
						database
							.select({ id: agentApiAuthorizationCodes.id })
							.from(agentApiAuthorizationCodes)
							.where(lt(agentApiAuthorizationCodes.expiresAt, now))
							.limit(batchSize),
					),
				),
		batchSize,
		maxBatches,
	);
	const idempotencyRecords = await deleteInBatches(
		() =>
			database
				.delete(agentApiIdempotency)
				.where(
					inArray(
						agentApiIdempotency.id,
						database
							.select({ id: agentApiIdempotency.id })
							.from(agentApiIdempotency)
							.where(lt(agentApiIdempotency.expiresAt, now))
							.limit(batchSize),
					),
				),
		batchSize,
		maxBatches,
	);
	const operations = await deleteInBatches(
		() =>
			database.delete(agentApiOperations).where(
				inArray(
					agentApiOperations.id,
					database
						.select({ id: agentApiOperations.id })
						.from(agentApiOperations)
						.where(
							and(
								inArray(agentApiOperations.state, ["succeeded", "failed"]),
								lt(agentApiOperations.updatedAt, operationRetentionCutoff),
							),
						)
						.limit(batchSize),
				),
			),
		batchSize,
		maxBatches,
	);
	const accessTokens = await deleteInBatches(
		() =>
			database.delete(agentApiKeys).where(
				inArray(
					agentApiKeys.id,
					database
						.select({ id: agentApiKeys.id })
						.from(agentApiKeys)
						.where(
							or(
								lt(agentApiKeys.expiresAt, keyRetentionCutoff),
								lt(agentApiKeys.revokedAt, keyRetentionCutoff),
							),
						)
						.limit(batchSize),
				),
			),
		batchSize,
		maxBatches,
	);

	return { authorizationCodes, idempotencyRecords, operations, accessTokens };
};
