"use server";

import { getCurrentUser } from "@cap/database/auth/session";
import { developerApiKeys } from "@cap/database/cloudflare/schema";
import { encrypt } from "@cap/database/crypto";
import { nanoId, nanoIdLong } from "@cap/database/helpers";
import { and, eq, isNull } from "drizzle-orm";
import { revalidatePath } from "next/cache";
import { hashKey } from "@/lib/developer-key-hash";
import { mutateOwnedDeveloperApp } from "@/lib/developer-persistence";

export async function regenerateDeveloperKeys(appId: string) {
	const user = await getCurrentUser();
	if (!user) throw new Error("Unauthorized");

	const publicKeyRaw = `cpk_${nanoIdLong()}`;
	const secretKeyRaw = `csk_${nanoIdLong()}`;
	const publicKeyHash = await hashKey(publicKeyRaw);
	const secretKeyHash = await hashKey(secretKeyRaw);
	const encryptedPublicKey = await encrypt(publicKeyRaw);
	const encryptedSecretKey = await encrypt(secretKeyRaw);

	const publicKeyId = nanoId();
	const secretKeyId = nanoId();
	const now = new Date();
	await mutateOwnedDeveloperApp(user.id, appId, (database) => [
		database
			.update(developerApiKeys)
			.set({ revokedAt: now })
			.where(
				and(
					eq(developerApiKeys.appId, appId),
					isNull(developerApiKeys.revokedAt),
				),
			),

		database.insert(developerApiKeys).values([
			{
				id: publicKeyId,
				appId,
				keyType: "public",
				keyPrefix: publicKeyRaw.slice(0, 12),
				keyHash: publicKeyHash,
				encryptedKey: encryptedPublicKey,
			},
			{
				id: secretKeyId,
				appId,
				keyType: "secret",
				keyPrefix: secretKeyRaw.slice(0, 12),
				keyHash: secretKeyHash,
				encryptedKey: encryptedSecretKey,
			},
		]),
	]);

	revalidatePath("/dashboard/developers");
	return {
		publicKey: publicKeyRaw,
		secretKey: secretKeyRaw,
	};
}
