"use server";

import { randomUUID } from "node:crypto";
import { getCurrentUser } from "@cap/database/auth/session";
import { db } from "@cap/database/cloudflare/application";
import { atomic } from "@cap/database/cloudflare/atomic";
import { spaces } from "@cap/database/cloudflare/schema";
import { S3Buckets } from "@cap/web-backend";
import { ImageUpload, type Space } from "@cap/web-domain";
import { eq } from "drizzle-orm";
import { Option } from "effect";
import { revalidatePath } from "next/cache";
import { requireManagedSpace } from "@/lib/organization-settings-persistence";
import { sanitizeFile } from "@/lib/sanitizeFile";
import { runPromise } from "@/lib/server";
import { requireSpaceManager } from "./space-authorization";

export async function uploadSpaceIcon(
	formData: FormData,
	spaceId: Space.SpaceId,
) {
	const user = await getCurrentUser();

	if (!user) {
		throw new Error("Unauthorized");
	}

	const spaceArr = await db()
		.select()
		.from(spaces)
		.where(eq(spaces.id, spaceId));

	if (!spaceArr || spaceArr.length === 0) {
		throw new Error("Space not found");
	}
	const space = spaceArr[0];

	if (!space) {
		throw new Error("Space not found");
	}

	await requireSpaceManager(user.id, spaceId);

	const file = formData.get("icon") as File;
	if (!file) {
		throw new Error("No file provided");
	}
	if (!file.type.startsWith("image/")) {
		throw new Error("File must be an image");
	}
	if (file.size > 1024 * 1024) {
		throw new Error("File size must be less than 1MB");
	}

	const fileExtension = file.name.split(".").pop();
	const fileKey = ImageUpload.ImageKey.make(
		`organizations/${
			space.organizationId
		}/spaces/${spaceId}/icon-${randomUUID()}.${fileExtension}`,
	);

	const [bucket] = await S3Buckets.getBucketAccess(Option.none()).pipe(
		runPromise,
	);

	try {
		const sanitizedFile = await sanitizeFile(file);
		const arrayBuffer = await sanitizedFile.arrayBuffer();

		await bucket
			.putObject(fileKey, new Uint8Array(arrayBuffer), {
				contentType: file.type,
			})
			.pipe(runPromise);

		const database = db();
		const oldIcon = await atomic(database, async (snapshot) => {
			const current = await requireManagedSpace(snapshot, user.id, spaceId);
			if (current.organizationId !== space.organizationId)
				throw new Error("Space organization changed");
			return {
				statements: [
					database
						.update(spaces)
						.set({ iconUrl: fileKey })
						.where(eq(spaces.id, spaceId)),
				],
				result: current.iconUrl,
			};
		});
		if (oldIcon) {
			const key = oldIcon.startsWith("organizations/")
				? oldIcon
				: oldIcon.match(/organizations\/.+/)?.[0];
			if (key) {
				try {
					await bucket.deleteObject(key).pipe(runPromise);
				} catch (e) {
					console.warn("Failed to delete old space icon from S3", e);
				}
			}
		}

		revalidatePath("/dashboard");
		return { success: true, iconUrl: fileKey };
	} catch (error) {
		console.error("Error uploading space icon:", error);
		throw new Error(error instanceof Error ? error.message : "Upload failed");
	}
}
