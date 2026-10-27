"use server";

import { getCurrentUser } from "@cap/database/auth/session";
import { db } from "@cap/database/cloudflare/application";
import { atomic } from "@cap/database/cloudflare/atomic";
import { spaceMembers, spaces } from "@cap/database/cloudflare/schema";
import { hashPassword } from "@cap/database/crypto";
import { nanoId } from "@cap/database/helpers";
import { userIsPro } from "@cap/utils";
import { S3Buckets } from "@cap/web-backend";
import { Space, type User } from "@cap/web-domain";
import { eq, type SQL, sql } from "drizzle-orm";
import { Effect, Option } from "effect";
import { revalidatePath } from "next/cache";
import { isOrganizationOwnerPro } from "@/lib/org-pro";
import {
	insertSpaceMembers,
	requireManagedSpace,
	requireSpaceRoster,
} from "@/lib/organization-settings-persistence";
import { normalizeSpaceRole } from "@/lib/permissions/roles";
import { runPromise } from "@/lib/server";
import { getSpaceAccess } from "./space-authorization";
import {
	getSpaceSettingsFromFormData,
	preserveProSpaceSettings,
} from "./space-settings";
import { uploadSpaceIcon } from "./upload-space-icon";

export async function updateSpace(formData: FormData) {
	const user = await getCurrentUser();
	if (!user) return { success: false, error: "Unauthorized" };

	const id = Space.SpaceId.make(formData.get("id") as string);
	const name = formData.get("name") as string;
	const members = formData.getAll("members[]") as User.UserId[];
	const iconFile = formData.get("icon") as File | null;
	const passwordAction = formData.get("passwordAction") as
		| "keep"
		| "set"
		| "remove"
		| null;
	const password = formData.get("password") as string | null;
	// Only touch the public flag when the form actually submitted it — callers
	// that omit the field must not silently un-publish the space.
	const publicField = formData.get("public");
	const publicEnabled = publicField === "true";

	const [space] = await db()
		.select({
			createdById: spaces.createdById,
			organizationId: spaces.organizationId,
			settings: spaces.settings,
			public: spaces.public,
		})
		.from(spaces)
		.where(eq(spaces.id, id))
		.limit(1);

	if (!space) {
		return { success: false, error: "Space not found" };
	}

	// getSpaceAccess returns null for expected denials; genuine failures must
	// propagate instead of being misreported as "Unauthorized".
	const access = await getSpaceAccess(user.id, id);
	if (!access?.canManage) {
		return { success: false, error: "Unauthorized" };
	}

	// Publishing is gated on the org owner's plan, but a downgraded org can
	// always un-publish — so only the false→true transition requires Pro.
	if (
		publicEnabled &&
		!space.public &&
		!(await isOrganizationOwnerPro(space.organizationId))
	) {
		return {
			success: false,
			error: "Upgrade to Cap Pro to create a public collection link",
		};
	}

	const submittedSettings = getSpaceSettingsFromFormData(formData);
	const canUseProFeatures = userIsPro(user);
	const viewerSettings = canUseProFeatures
		? submittedSettings
		: preserveProSpaceSettings(submittedSettings, space.settings);
	// Atomic per-key merge: the form submits every viewer-settings key
	// explicitly, while settings.publicPage (managed by the visibility/logo
	// actions, possibly concurrently) is left untouched instead of being
	// rewritten from a stale snapshot.
	const spaceUpdate: {
		name: string;
		settings: SQL;
		public?: boolean;
		password?: string | null;
	} = {
		name,
		settings: sql`json_patch(coalesce(${spaces.settings}, '{}'), ${JSON.stringify(
			viewerSettings,
		)})`,
	};
	if (publicField !== null) spaceUpdate.public = publicEnabled;

	if (passwordAction === "set") {
		if (!canUseProFeatures) {
			return {
				success: false,
				error: "Upgrade required to protect a space with a password",
			};
		}
		if (!password?.trim()) {
			return { success: false, error: "Space password is required" };
		}
		spaceUpdate.password = await hashPassword(password.trim());
	} else if (passwordAction === "remove") {
		spaceUpdate.password = null;
	}

	const database = db();
	const operationId = nanoId();
	const now = new Date();
	const oldIcon = await atomic(database, async (snapshot) => {
		const current = await requireManagedSpace(snapshot, user.id, id);
		const memberIds = Array.from(new Set([...members, current.createdById]));
		await requireSpaceRoster(snapshot, current, memberIds);
		const existing = await snapshot.read((reader) =>
			reader.select().from(spaceMembers).where(eq(spaceMembers.spaceId, id)),
		);
		const roles = new Map(
			existing.map((member) => [
				member.userId,
				normalizeSpaceRole(member.role) ?? "member",
			]),
		);
		const settings = canUseProFeatures
			? submittedSettings
			: preserveProSpaceSettings(submittedSettings, current.settings);
		return {
			statements: [
				database
					.update(spaces)
					.set({
						...spaceUpdate,
						settings: sql`json_patch(coalesce(${spaces.settings}, '{}'), ${JSON.stringify(settings)})`,
						...(formData.get("removeIcon") === "true" ? { iconUrl: null } : {}),
					})
					.where(eq(spaces.id, id)),
				database.delete(spaceMembers).where(eq(spaceMembers.spaceId, id)),
				insertSpaceMembers(
					database,
					id,
					memberIds.map((userId) => ({
						userId,
						role:
							userId === current.createdById
								? "admin"
								: (roles.get(userId) ?? "member"),
					})),
					operationId,
					now,
				),
			],
			result: current.iconUrl,
		};
	});

	if (formData.get("removeIcon") === "true") {
		if (oldIcon) {
			const key = oldIcon.startsWith("organizations/")
				? oldIcon
				: oldIcon.match(/organizations\/.+/)?.[0];

			if (key) {
				try {
					await Effect.gen(function* () {
						const [bucket] = yield* S3Buckets.getBucketAccess(Option.none());
						yield* bucket.deleteObject(key);
					}).pipe(runPromise);
				} catch (e) {
					console.warn("Failed to delete old space icon from S3", e);
				}
			}
		}
	} else if (iconFile && iconFile.size > 0) {
		await uploadSpaceIcon(formData, id);
	}

	revalidatePath("/dashboard");
	revalidatePath("/dashboard/caps");
	revalidatePath(`/dashboard/spaces/${id}`);
	revalidatePath(`/c/${id}`);
	return { success: true };
}
