"use server";

import { getCurrentUser } from "@cap/database/auth/session";
import { requireOrganizationMember } from "@cap/database/cloudflare/access";
import { db } from "@cap/database/cloudflare/application";
import { type AtomicStatement, atomic } from "@cap/database/cloudflare/atomic";
import {
	organizationMembers,
	spaceMembers,
	spaces,
} from "@cap/database/cloudflare/schema";
import { hashPassword } from "@cap/database/crypto";
import { nanoId } from "@cap/database/helpers";
import { userIsPro } from "@cap/utils";
import {
	type ImageUpload,
	Organisation,
	Space,
	SpaceMemberId,
	type SpaceMemberRole,
	User,
} from "@cap/web-domain";
import { and, eq, inArray } from "drizzle-orm";
import { revalidatePath } from "next/cache";
import { isOrganizationOwnerPro } from "@/lib/org-pro";
import {
	getSpaceSettingsFromFormData,
	hasProSpaceSettingsEnabled,
} from "./space-settings";
import { uploadSpaceIcon } from "./upload-space-icon";

interface CreateSpaceResponse {
	success: boolean;
	spaceId?: string;
	name?: string;
	iconUrl?: string | null;
	error?: string;
}

export async function createSpace(
	formData: FormData,
): Promise<CreateSpaceResponse> {
	try {
		const user = await getCurrentUser();

		if (!user || !user.activeOrganizationId) {
			return {
				success: false,
				error: "User not logged in or no active organization",
			};
		}

		const name = formData.get("name") as string;
		const passwordEnabled = formData.get("passwordEnabled") === "true";
		const password = formData.get("password") as string | null;
		const publicEnabled = formData.get("public") === "true";
		const settings = getSpaceSettingsFromFormData(formData);
		const canUseProFeatures = userIsPro(user);

		if (!name) {
			return {
				success: false,
				error: "Space name is required",
			};
		}

		if (passwordEnabled && !password?.trim()) {
			return {
				success: false,
				error: "Space password is required",
			};
		}

		if (!canUseProFeatures && passwordEnabled) {
			return {
				success: false,
				error: "Upgrade required to protect a space with a password",
			};
		}

		if (!canUseProFeatures && hasProSpaceSettingsEnabled(settings)) {
			return {
				success: false,
				error: "Upgrade required to change these viewer rules",
			};
		}

		if (
			publicEnabled &&
			!(await isOrganizationOwnerPro(
				Organisation.OrganisationId.make(user.activeOrganizationId),
			))
		) {
			return {
				success: false,
				error: "Upgrade to Cap Pro to create a public collection link",
			};
		}

		const spaceId = Space.SpaceId.make(nanoId());
		let iconUrl: ImageUpload.ImageUrlOrKey | null = null;
		const hashedPassword =
			passwordEnabled && password?.trim()
				? await hashPassword(password.trim())
				: null;

		const selectedMembers = [
			...new Set([
				...formData
					.getAll("members[]")
					.filter(
						(value): value is string =>
							typeof value === "string" && value.length > 0,
					),
				user.id,
			]),
		];
		if (selectedMembers.length > 900)
			throw new Error("Select at most 900 space members per request.");
		if (name.length > 255)
			throw new Error("Space name must contain at most 255 characters.");
		const members = selectedMembers.map((userId) => ({
			id: SpaceMemberId.make(nanoId()),
			spaceId,
			userId: User.UserId.make(userId),
			role: (userId === user.id ? "admin" : "member") as SpaceMemberRole,
		}));
		const database = db();
		await atomic(database, async (snapshot) => {
			const { organization } = await requireOrganizationMember(
				snapshot,
				user.activeOrganizationId,
				user.id,
			);
			const existingSpaces = await snapshot.read((reader) =>
				reader
					.select({ name: spaces.name })
					.from(spaces)
					.where(eq(spaces.organizationId, organization.id)),
			);
			if (
				existingSpaces.some(
					(space) =>
						space.name.normalize("NFC").toLowerCase() ===
						name.normalize("NFC").toLowerCase(),
				)
			)
				throw new Error("A space with this name already exists.");
			const allowed = new Set<string>([organization.ownerId]);
			for (let offset = 0; offset < members.length; offset += 80) {
				const present = await snapshot.read((reader) =>
					reader
						.select({ id: organizationMembers.userId })
						.from(organizationMembers)
						.where(
							and(
								eq(organizationMembers.organizationId, organization.id),
								inArray(
									organizationMembers.userId,
									members
										.slice(offset, offset + 80)
										.map((member) => member.userId),
								),
							),
						),
				);
				for (const member of present) allowed.add(member.id);
			}
			if (selectedMembers.some((id) => !allowed.has(id)))
				throw new Error("Space members must belong to the organization.");
			const statements: AtomicStatement[] = [
				database.insert(spaces).values({
					id: spaceId,
					name,
					organizationId: organization.id,
					createdById: user.id,
					iconUrl: null,
					settings,
					password: hashedPassword,
					public: publicEnabled,
				}),
			];
			for (let offset = 0; offset < members.length; offset += 20)
				statements.push(
					database
						.insert(spaceMembers)
						.values(members.slice(offset, offset + 20)),
				);
			return { statements, result: undefined };
		});

		const iconFile = formData.get("icon") as File | null;

		if (iconFile) {
			try {
				const iconFormData = new FormData();
				iconFormData.append("icon", iconFile);
				const result = await uploadSpaceIcon(iconFormData, spaceId);
				iconUrl = result.iconUrl;
			} catch (error) {
				console.error("Error uploading space icon:", error);
			}
		}

		revalidatePath("/dashboard");

		return {
			success: true,
			spaceId,
			iconUrl,
			name,
		};
	} catch (error) {
		console.error("Error creating space:", error);
		return {
			success: false,
			error: "Failed to create space",
		};
	}
}
