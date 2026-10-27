"use server";

import { randomUUID } from "node:crypto";
import { getCurrentUser } from "@cap/database/auth/session";
import { requireWorkspaceAccount } from "@cap/database/cloudflare/access";
import { db } from "@cap/database/cloudflare/application";
import { atomic } from "@cap/database/cloudflare/atomic";
import {
	organizationMembers,
	organizations,
	users,
} from "@cap/database/cloudflare/schema";
import { nanoId } from "@cap/database/helpers";
import { S3Buckets } from "@cap/web-backend";
import { ImageUpload, Organisation } from "@cap/web-domain";
import { eq } from "drizzle-orm";
import { Effect, Option } from "effect";
import { revalidatePath } from "next/cache";
import { runPromise } from "@/lib/server";

export async function createOrganization(formData: FormData) {
	const user = await getCurrentUser();
	if (!user) throw new Error("Unauthorized");
	const database = db();
	await atomic(database, async (snapshot) => ({
		statements: [],
		result: await requireWorkspaceAccount(snapshot, user.id),
	}));
	const nameValue = formData.get("name");
	const name = typeof nameValue === "string" ? nameValue.trim() : "";
	if (!name || name.length > 255)
		throw new Error(
			"Organization name must contain between 1 and 255 characters",
		);
	const organizationId = Organisation.OrganisationId.make(nanoId());
	const memberId = nanoId();
	let iconUrl: ImageUpload.ImageUrlOrKey | undefined;
	const iconFile = formData.get("icon");
	if (iconFile instanceof File && iconFile.size > 0) {
		if (!iconFile.type.startsWith("image/"))
			throw new Error("File must be an image");
		if (iconFile.size > 2 * 1024 * 1024)
			throw new Error("File size must be less than 2MB");
		const extension = iconFile.name.split(".").pop() ?? "png";
		const safeExtension = /^[a-z0-9]{1,10}$/i.test(extension)
			? extension
			: "png";
		iconUrl = ImageUpload.ImageKey.make(
			`organizations/${organizationId}/icon-${randomUUID()}.${safeExtension}`,
		);
		const key = iconUrl;
		await Effect.gen(function* () {
			const [bucket] = yield* S3Buckets.getBucketAccess(Option.none());
			yield* bucket.putObject(
				key,
				yield* Effect.promise(() => iconFile.arrayBuffer()),
				{ contentType: iconFile.type },
			);
		}).pipe(runPromise);
	}
	await atomic(database, async (snapshot) => {
		await requireWorkspaceAccount(snapshot, user.id);
		const [existing] = await snapshot.read((reader) =>
			reader
				.select({ id: organizations.id })
				.from(organizations)
				.where(eq(organizations.name, name))
				.limit(1),
		);
		if (existing) throw new Error("Organization with this name already exists");
		return {
			statements: [
				database
					.insert(organizations)
					.values({ id: organizationId, ownerId: user.id, name, iconUrl }),
				database
					.insert(organizationMembers)
					.values({
						id: memberId,
						userId: user.id,
						role: "owner",
						organizationId,
					}),
				database
					.update(users)
					.set({ activeOrganizationId: organizationId })
					.where(eq(users.id, user.id)),
			],
			result: undefined,
		};
	});
	revalidatePath("/dashboard");
	return { success: true, organizationId };
}
