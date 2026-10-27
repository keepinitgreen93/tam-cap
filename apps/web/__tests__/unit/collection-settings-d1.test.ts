import {
	folders,
	organizationMembers,
	organizations,
	spaces,
	users,
} from "@cap/database/cloudflare/schema";
import { nanoId } from "@cap/database/helpers";
import { ImageUploads } from "@cap/web-backend";
import { Folder, ImageUpload, Space } from "@cap/web-domain";
import { eq } from "drizzle-orm";
import { Effect, Option } from "effect";
import { afterAll, beforeAll, beforeEach, expect, it, vi } from "vitest";
import { createTestDatabase } from "../../../../packages/database/cloudflare/test-runtime";
import { createTestOwner } from "../helpers/cloudflare-team";

let fixture: Awaited<ReturnType<typeof createTestDatabase>>;
let actor: typeof users.$inferSelect;
let beforeWrite: (() => Promise<void>) | null = null;
let afterEntitlement: (() => Promise<void>) | null = null;
const deleted: string[] = [];
vi.mock("server-only", () => ({}));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
vi.mock("@/lib/sanitizeFile", () => ({
	sanitizeFile: async (file: File) => file,
}));
vi.mock("@cap/database/auth/session", () => ({
	getCurrentUser: async () => actor,
}));
vi.mock("@cap/database/cloudflare/application", () => ({
	db: () => fixture.database,
}));
vi.mock("@/lib/org-pro", () => ({
	isOrganizationOwnerPro: async () => {
		await afterEntitlement?.();
		return true;
	},
}));
vi.mock("@/lib/server", () => ({
	runPromise: <A, E>(effect: Effect.Effect<A, E, ImageUploads>) =>
		Effect.runPromise(
			effect.pipe(
				Effect.provideService(
					ImageUploads,
					ImageUploads.make({
						applyUpdate: (args) =>
							Effect.promise(async () => {
								await beforeWrite?.();
								await args.update(
									fixture.database,
									Option.isSome(args.payload)
										? ImageUpload.ImageKey.make(
												`${args.keyPrefix}/${nanoId()}.png`,
											)
										: null,
								);
								if (Option.isSome(args.existing))
									deleted.push(args.existing.value);
							}),
						resolveImageUrl: () =>
							Effect.succeed(
								ImageUpload.ImageUrl.make("https://example.com/logo.png"),
							),
					}),
				),
			),
		),
}));

import { setCollectionLogo } from "@/actions/collections/logo";
import { setSpaceCollectionVisibility } from "@/actions/collections/visibility";
import { updateOrganizationSettings } from "@/actions/organization/settings";
import { removeShareableLinkIcon } from "@/actions/organization/shareable-link-icon";
import { updateOrganizationDetails } from "@/actions/organization/update-details";
import { updateSpace } from "@/actions/organization/update-space";

beforeAll(async () => {
	vi.stubEnv("NEXT_PUBLIC_WEB_URL", "https://videos.example.com");
	fixture = await createTestDatabase();
}, 120000);
afterAll(async () => {
	await fixture.dispose();
	vi.unstubAllEnvs();
});
beforeEach(() => {
	beforeWrite = null;
	afterEntitlement = null;
	deleted.length = 0;
});

async function collection() {
	actor = await createTestOwner(fixture.database);
	actor = { ...actor, stripeSubscriptionStatus: "active" };
	await fixture.database
		.update(users)
		.set({ stripeSubscriptionStatus: "active" })
		.where(eq(users.id, actor.id));
	const spaceId = Space.SpaceId.make(nanoId());
	await fixture.database.insert(spaces).values({
		id: spaceId,
		organizationId: actor.activeOrganizationId,
		createdById: actor.id,
		name: "Collection",
		settings: {
			publicPage: {
				title: "Preserved",
				logoUrl: "organizations/old/logo.png",
				logoMode: "custom",
			},
		},
	});
	return { owner: actor, spaceId };
}
function removeLogo(id: string, kind = "space") {
	const form = new FormData();
	form.set("collectionId", id);
	form.set("kind", kind);
	form.set("remove", "true");
	return setCollectionLogo(form);
}

it("merges visibility settings without losing the current logo and rejects revoked managers", async () => {
	const value = await collection();
	await setSpaceCollectionVisibility({
		spaceId: value.spaceId,
		public: true,
		settings: { title: "Updated" },
	});
	const [updated] = await fixture.database
		.select()
		.from(spaces)
		.where(eq(spaces.id, value.spaceId));
	expect(updated?.settings?.publicPage).toMatchObject({
		title: "Updated",
		logoUrl: "organizations/old/logo.png",
	});
	const admin = await createTestOwner(fixture.database);
	const memberId = nanoId();
	await fixture.database.insert(organizationMembers).values({
		id: memberId,
		organizationId: value.owner.activeOrganizationId,
		userId: admin.id,
		role: "admin",
	});
	actor = admin;
	afterEntitlement = async () => {
		await fixture.database
			.delete(organizationMembers)
			.where(eq(organizationMembers.id, memberId));
	};
	await expect(
		setSpaceCollectionVisibility({
			spaceId: value.spaceId,
			settings: { title: "Unauthorized" },
		}),
	).rejects.toThrow("membership is required");
	expect(
		(
			await fixture.database
				.select()
				.from(spaces)
				.where(eq(spaces.id, value.spaceId))
		)[0]?.settings?.publicPage?.title,
	).toBe("Updated");
});

it("updates organization settings and details concurrently without losing existing preferences", async () => {
	const value = await collection();
	await fixture.database
		.update(organizations)
		.set({ settings: { disableSummary: true, defaultPlaybackSpeed: 1.25 } })
		.where(eq(organizations.id, value.owner.activeOrganizationId));
	await Promise.all([
		updateOrganizationSettings({ disableComments: true }),
		updateOrganizationDetails({
			organizationId: value.owner.activeOrganizationId,
			organizationName: "Renamed",
			allowedEmailDomain: "example.com",
		}),
	]);
	const [organization] = await fixture.database
		.select()
		.from(organizations)
		.where(eq(organizations.id, value.owner.activeOrganizationId));
	expect(organization).toMatchObject({
		name: "Renamed",
		allowedEmailDomain: "example.com",
		settings: {
			disableSummary: true,
			disableComments: true,
			defaultPlaybackSpeed: 1.25,
		},
	});
});

it("replaces space membership and updates native JSON atomically without unpublishing omitted public fields", async () => {
	const value = await collection();
	await fixture.database
		.update(spaces)
		.set({ public: true })
		.where(eq(spaces.id, value.spaceId));
	const form = new FormData();
	form.set("id", value.spaceId);
	form.set("name", "Updated space");
	expect(await updateSpace(form)).toEqual({ success: true });
	const [space] = await fixture.database
		.select()
		.from(spaces)
		.where(eq(spaces.id, value.spaceId));
	expect(space).toMatchObject({
		name: "Updated space",
		public: true,
		settings: {
			publicPage: { title: "Preserved", logoUrl: "organizations/old/logo.png" },
		},
	});
	const outsider = await createTestOwner(fixture.database);
	form.set("name", "Rejected name");
	form.append("members[]", outsider.id);
	await expect(updateSpace(form)).rejects.toThrow("must belong");
	expect(
		(
			await fixture.database
				.select()
				.from(spaces)
				.where(eq(spaces.id, value.spaceId))
		)[0]?.name,
	).toBe("Updated space");
});

it("refuses stale organization branding callbacks without deleting the active image", async () => {
	const value = await collection();
	await fixture.database
		.update(organizations)
		.set({
			shareableLinkIconUrl: ImageUpload.ImageKey.make(
				"organizations/old/branding.png",
			),
		})
		.where(eq(organizations.id, value.owner.activeOrganizationId));
	beforeWrite = async () => {
		await fixture.database
			.update(organizations)
			.set({
				shareableLinkIconUrl: ImageUpload.ImageKey.make(
					"organizations/new/branding.png",
				),
			})
			.where(eq(organizations.id, value.owner.activeOrganizationId));
	};
	await expect(
		removeShareableLinkIcon(value.owner.activeOrganizationId),
	).rejects.toThrow("Organization branding changed");
	expect(deleted).toEqual([]);
	expect(
		(
			await fixture.database
				.select()
				.from(organizations)
				.where(eq(organizations.id, value.owner.activeOrganizationId))
		)[0]?.shareableLinkIconUrl,
	).toBe("organizations/new/branding.png");
});

it("rejects a stale logo swap without deleting either the old or concurrently published object", async () => {
	const value = await collection();
	beforeWrite = async () => {
		await fixture.database
			.update(spaces)
			.set({
				settings: {
					publicPage: {
						title: "Concurrent",
						logoUrl: "organizations/new/logo.png",
						logoMode: "custom",
					},
				},
			})
			.where(eq(spaces.id, value.spaceId));
	};
	await expect(removeLogo(value.spaceId)).rejects.toThrow(
		"Collection logo changed",
	);
	expect(deleted).toEqual([]);
	expect(
		(
			await fixture.database
				.select()
				.from(spaces)
				.where(eq(spaces.id, value.spaceId))
		)[0]?.settings?.publicPage?.logoUrl,
	).toBe("organizations/new/logo.png");
});

it("rechecks space management after the image operation and before publishing metadata", async () => {
	const value = await collection();
	const admin = await createTestOwner(fixture.database);
	const memberId = nanoId();
	await fixture.database.insert(organizationMembers).values({
		id: memberId,
		organizationId: value.owner.activeOrganizationId,
		userId: admin.id,
		role: "admin",
	});
	actor = admin;
	beforeWrite = async () => {
		await fixture.database
			.delete(organizationMembers)
			.where(eq(organizationMembers.id, memberId));
	};
	await expect(removeLogo(value.spaceId)).rejects.toThrow(
		"membership is required",
	);
	expect(deleted).toEqual([]);
});

it("preserves folder settings and refuses a creator removed from the organization", async () => {
	const value = await collection();
	const id = Folder.FolderId.make(nanoId());
	await fixture.database.insert(folders).values({
		id,
		name: "Personal",
		organizationId: value.owner.activeOrganizationId,
		createdById: value.owner.id,
		settings: {
			publicPage: {
				title: "Preserved",
				logoUrl: "organizations/old/logo.png",
				logoMode: "custom",
			},
		},
	});
	await removeLogo(id, "folder");
	const [updated] = await fixture.database
		.select()
		.from(folders)
		.where(eq(folders.id, id));
	expect(updated?.settings?.publicPage).toEqual({
		title: "Preserved",
		logoMode: "cap",
	});
	expect(deleted).toEqual(["organizations/old/logo.png"]);
	const creator = await createTestOwner(fixture.database);
	await fixture.database
		.update(folders)
		.set({ createdById: creator.id })
		.where(eq(folders.id, id));
	actor = creator;
	await expect(removeLogo(id, "folder")).rejects.toThrow(
		"membership is required",
	);
});
