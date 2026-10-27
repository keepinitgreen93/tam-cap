"use server";

import { getCurrentUser } from "@cap/database/auth/session";
import { developerCreditAccounts } from "@cap/database/cloudflare/schema";
import { buildEnv } from "@cap/env";
import { eq } from "drizzle-orm";
import { revalidatePath } from "next/cache";
import { mutateOwnedDeveloperApp } from "@/lib/developer-persistence";

export async function updateDeveloperAutoTopUp(data: {
	appId: string;
	enabled: boolean;
	thresholdMicroCredits?: number;
	amountCents?: number;
}) {
	const user = await getCurrentUser();
	if (!user) throw new Error("Unauthorized");
	if (buildEnv.NEXT_PUBLIC_IS_CAP !== "true" && data.enabled)
		throw new Error(
			"Credit auto top-up is unavailable on this self-hosted server",
		);

	if (
		data.thresholdMicroCredits !== undefined &&
		data.thresholdMicroCredits < 0
	) {
		throw new Error("Threshold must be non-negative");
	}
	if (data.amountCents !== undefined && data.amountCents <= 0) {
		throw new Error("Top-up amount must be positive");
	}
	if (data.amountCents !== undefined && data.amountCents > 100_000) {
		throw new Error("Top-up amount must be between $0.01 and $1,000.00");
	}

	const updates: Partial<typeof developerCreditAccounts.$inferInsert> = {
		autoTopUpEnabled: data.enabled,
	};

	if (data.thresholdMicroCredits !== undefined) {
		updates.autoTopUpThresholdMicroCredits = data.thresholdMicroCredits;
	}
	if (data.amountCents !== undefined) {
		updates.autoTopUpAmountCents = data.amountCents;
	}

	await mutateOwnedDeveloperApp(user.id, data.appId, (database) => [
		database
			.update(developerCreditAccounts)
			.set(updates)
			.where(eq(developerCreditAccounts.appId, data.appId)),
	]);

	revalidatePath("/dashboard/developers");
	return { success: true };
}
