"use server";

import { getCurrentUser } from "@cap/database/auth/session";
import { db } from "@cap/database/cloudflare/application";
import { atomic } from "@cap/database/cloudflare/atomic";
import { spaces } from "@cap/database/cloudflare/schema";
import { PublicCollection, Space } from "@cap/web-domain";
import { eq, type SQL, sql } from "drizzle-orm";
import { Either, Schema } from "effect";
import { revalidatePath } from "next/cache";
import { isOrganizationOwnerPro } from "@/lib/org-pro";
import { requireManagedSpace } from "@/lib/organization-settings-persistence";
import { getSpaceAccess } from "../organization/space-authorization";

const decodeSettingsPatch = Schema.decodeUnknownEither(
	PublicCollection.PublicPageSettingsUpdate,
);

/**
 * Toggles a space's public collection link and/or its public-page presentation
 * settings from the dashboard space page. Enabling public (or customizing the
 * page) requires the org owner to be on Pro; un-publishing is always allowed.
 *
 * `settings` is a partial patch merged into the stored `settings.publicPage`,
 * mirroring the folder path (FolderUpdate RPC).
 */
export async function setSpaceCollectionVisibility(input: {
	spaceId: string;
	public?: boolean;
	settings?: PublicCollection.PublicPageSettingsUpdate;
}) {
	const user = await getCurrentUser();
	if (!user) return { success: false, error: "Unauthorized" };

	// Server actions are publicly callable; the TS parameter types are
	// compile-time only, so validate everything before it reaches the database.
	if (typeof input.spaceId !== "string" || input.spaceId.length === 0) {
		return { success: false, error: "Invalid request" };
	}
	if (input.public !== undefined && typeof input.public !== "boolean") {
		return { success: false, error: "Invalid request" };
	}

	let settingsPatch: PublicCollection.PublicPageSettingsUpdate | undefined;
	if (input.settings !== undefined) {
		const decoded = decodeSettingsPatch(input.settings);
		if (Either.isLeft(decoded)) {
			return { success: false, error: "Invalid public page settings" };
		}
		settingsPatch = decoded.right;
	}

	const id = Space.SpaceId.make(input.spaceId);

	// getSpaceAccess returns null for the expected denials (missing space, no
	// membership) and only throws on genuine failures, which must propagate
	// instead of being misreported as "Unauthorized".
	const [[space], access] = await Promise.all([
		db()
			.select({
				organizationId: spaces.organizationId,
				public: spaces.public,
			})
			.from(spaces)
			.where(eq(spaces.id, id))
			.limit(1),
		getSpaceAccess(user.id, id),
	]);

	if (!space) return { success: false, error: "Space not found" };
	if (!access?.canManage) return { success: false, error: "Unauthorized" };

	const enablingPublic = input.public === true && !space.public;
	const changingSettings = settingsPatch !== undefined;

	if (
		(enablingPublic || changingSettings) &&
		!(await isOrganizationOwnerPro(space.organizationId))
	) {
		return {
			success: false,
			error: "Upgrade to Cap Pro to create a public collection link",
		};
	}

	const update: { public?: boolean; settings?: SQL } = {};
	if (input.public !== undefined) update.public = input.public;
	if (settingsPatch !== undefined) {
		// Atomic merge so concurrent patches (and the logo upload action, which
		// also writes settings.publicPage) can't overwrite each other's keys.
		update.settings = sql`json_patch(COALESCE(${spaces.settings}, '{}'), ${JSON.stringify(
			{ publicPage: settingsPatch },
		)})`;
	}

	const database = db();
	await atomic(database, async (snapshot) => {
		await requireManagedSpace(snapshot, user.id, id);
		return {
			statements: Object.keys(update).length
				? [database.update(spaces).set(update).where(eq(spaces.id, id))]
				: [],
			result: undefined,
		};
	});

	revalidatePath("/dashboard");
	revalidatePath(`/dashboard/spaces/${id}`);
	revalidatePath(`/c/${id}`);
	return { success: true };
}
