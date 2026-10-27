import { db } from "@cap/database/cloudflare/application";
import { atomic } from "@cap/database/cloudflare/atomic";
import {
	type DeveloperCreditReferenceType,
	developerCreditAccounts,
	developerCreditTransactions,
} from "@cap/database/cloudflare/schema";
import { nanoId } from "@cap/database/helpers";
import { and, eq } from "drizzle-orm";

const MICRO_CREDITS_PER_DOLLAR = 100_000;

export async function addCreditsToAccount({
	accountId,
	amountCents,
	referenceId,
	referenceType,
	metadata,
}: {
	accountId: string;
	amountCents: number;
	referenceId?: string;
	referenceType?: DeveloperCreditReferenceType;
	metadata?: Record<string, unknown>;
}): Promise<number> {
	if (!Number.isSafeInteger(amountCents) || amountCents <= 0) {
		throw new Error("Credit amount must be a positive integer number of cents");
	}
	const microCreditsToAdd = Math.floor(
		(amountCents / 100) * MICRO_CREDITS_PER_DOLLAR,
	);

	const transactionId = nanoId();
	const database = db();
	return atomic(database, async (snapshot) => {
		const [account] = await snapshot.read((reader) =>
			reader
				.select({
					balanceMicroCredits: developerCreditAccounts.balanceMicroCredits,
				})
				.from(developerCreditAccounts)
				.where(eq(developerCreditAccounts.id, accountId))
				.limit(1),
		);

		if (!account) {
			throw new Error(`Credit account not found: ${accountId}`);
		}

		if (referenceId && referenceType) {
			const [existing] = await snapshot.read((reader) =>
				reader
					.select()
					.from(developerCreditTransactions)
					.where(
						and(
							eq(developerCreditTransactions.accountId, accountId),
							eq(developerCreditTransactions.referenceId, referenceId),
							eq(developerCreditTransactions.referenceType, referenceType),
						),
					)
					.limit(1),
			);
			if (existing) {
				if (
					existing.type !== "topup" ||
					existing.amountMicroCredits !== microCreditsToAdd
				)
					throw new Error(
						"Credit reference conflicts with an existing transaction",
					);
				return { statements: [], result: existing.balanceAfterMicroCredits };
			}
		}
		const newBalance = account.balanceMicroCredits + microCreditsToAdd;
		if (!Number.isSafeInteger(newBalance))
			throw new Error("Credit balance exceeds the supported range");
		return {
			statements: [
				database
					.update(developerCreditAccounts)
					.set({ balanceMicroCredits: newBalance })
					.where(eq(developerCreditAccounts.id, accountId)),
				database.insert(developerCreditTransactions).values({
					id: transactionId,
					accountId,
					type: "topup",
					amountMicroCredits: microCreditsToAdd,
					balanceAfterMicroCredits: newBalance,
					referenceId,
					referenceType,
					metadata: metadata ?? { amountCents },
				}),
			],
			result: newBalance,
		};
	});
}
