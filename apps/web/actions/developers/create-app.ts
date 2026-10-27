"use server";

import { getCurrentUser } from "@cap/database/auth/session";
import { requireWorkspaceAccount } from "@cap/database/cloudflare/access";
import { db } from "@cap/database/cloudflare/application";
import { atomic } from "@cap/database/cloudflare/atomic";
import {
	developerApiKeys,
	developerApps,
	developerCreditAccounts,
} from "@cap/database/cloudflare/schema";
import { encrypt } from "@cap/database/crypto";
import { nanoId, nanoIdLong } from "@cap/database/helpers";
import { hashKey } from "@/lib/developer-key-hash";

export async function createDeveloperApp(data: {
	name: string;
	environment: "development" | "production";
}) {
	const user = await getCurrentUser();
	if (!user) throw new Error("Unauthorized");

	if (data.name.trim().length > 255) throw new Error("App name is too long");
	if (!["development", "production"].includes(data.environment))
		throw new Error("Invalid environment");
	if (!data.name.trim()) throw new Error("App name is required");

	const appId = nanoId();
	const publicKeyId = nanoId();
	const secretKeyId = nanoId();
	const accountId = nanoId();
	const publicKeyRaw = `cpk_${nanoIdLong()}`;
	const secretKeyRaw = `csk_${nanoIdLong()}`;
	const publicKeyHash = await hashKey(publicKeyRaw);
	const secretKeyHash = await hashKey(secretKeyRaw);

	const encryptedPublicKey = await encrypt(publicKeyRaw);
	const encryptedSecretKey = await encrypt(secretKeyRaw);

	const database = db();
	await atomic(database, async (snapshot) => {
		await requireWorkspaceAccount(snapshot, user.id);
		return {
			statements: [
				database.insert(developerApps).values({
					id: appId,
					ownerId: user.id,
					name: data.name.trim(),
					environment: data.environment,
				}),

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

				database.insert(developerCreditAccounts).values({
					id: accountId,
					appId,
					ownerId: user.id,
				}),
			],
			result: undefined,
		};
	});

	return {
		appId,
		publicKey: publicKeyRaw,
		secretKey: secretKeyRaw,
	};
}
