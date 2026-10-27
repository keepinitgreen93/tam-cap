import {
	comments,
	folders,
	organizationInvites,
	organizations,
	sharedVideos,
	spaces,
	type users,
	videos,
} from "@cap/database/cloudflare/schema";
import { nanoId } from "@cap/database/helpers";
import type {
	CloudflareDatabase,
	ImageUploads,
	Spaces,
} from "@cap/web-backend";
import { eq } from "drizzle-orm";
import { Effect, Layer } from "effect";
import {
	afterAll,
	beforeAll,
	beforeEach,
	describe,
	expect,
	it,
	vi,
} from "vitest";
import { createTestDatabase } from "../../../../packages/database/cloudflare/test-runtime.ts";
import { createTestOwner } from "../helpers/cloudflare-team";

vi.mock("server-only", () => ({}));
const state = vi.hoisted(() => ({
	database: undefined as
		| Awaited<ReturnType<typeof createTestDatabase>>["database"]
		| undefined,
	user: null as Awaited<ReturnType<typeof createTestOwner>> | null,
}));
vi.mock("@cap/database", () => ({
	db: () => {
		throw new Error("Dashboard must not access MySQL");
	},
}));
vi.mock("@cap/database/cloudflare/application", () => ({
	db: () => {
		if (!state.database) throw new Error("Test database unavailable");
		return state.database;
	},
}));
vi.mock("@cap/database/auth/session", () => ({
	getCurrentUser: async () => state.user,
}));
vi.mock("@cap/env", () => ({
	serverEnv: () => ({}),
	buildEnv: {
		NEXT_PUBLIC_IS_CAP: "false",
		NEXT_PUBLIC_WEB_URL: "https://cap.test",
	},
}));
vi.mock("@cap/web-backend", async () => {
	const { CurrentUser } = await import("@cap/web-domain");
	const { Layer, Option } = await import("effect");
	return {
		CloudflareDatabase: (
			await import("../../../../packages/web-backend/src/CloudflareDatabase")
		).CloudflareDatabase,
		ImageUploads: (
			await import("../../../../packages/web-backend/src/ImageUploads")
		).ImageUploads,
		Spaces: (await import("../../../../packages/web-backend/src/Spaces"))
			.Spaces,
		resolveEffectiveVideoRules: (
			await import(
				"../../../../packages/web-backend/src/Videos/EffectiveVideoRules"
			)
		).resolveEffectiveVideoRules,
		makeCurrentUserLayer: (user: typeof users.$inferSelect) =>
			Layer.succeed(CurrentUser, {
				id: user.id,
				email: user.email,
				activeOrganizationId: user.activeOrganizationId,
				iconUrlOrKey: Option.none(),
			}),
	};
});
vi.mock("@/lib/server", async () => {
	const { CloudflareDatabase, ImageUploads, Spaces } = await import(
		"@cap/web-backend"
	);
	const { ImageUpload } = await import("@cap/web-domain");
	return {
		runPromise: <A, E>(
			effect: Effect.Effect<A, E, CloudflareDatabase | ImageUploads | Spaces>,
		) =>
			Effect.runPromise(
				effect.pipe(
					Effect.provide(
						Layer.mergeAll(
							CloudflareDatabase.Default,
							Spaces.Default,
							Layer.succeed(
								ImageUploads,
								ImageUploads.make({
									applyUpdate: () => Effect.void,
									resolveImageUrl: (value: string) =>
										Effect.succeed(ImageUpload.ImageUrl.make(value)),
								}),
							),
						),
					),
				),
			),
	};
});
vi.mock("@/app/(org)/dashboard/caps/Caps", () => ({ Caps: () => null }));
vi.mock("@/app/(org)/dashboard/spaces/[spaceId]/SharedCaps", () => ({
	SharedCaps: () => null,
}));
vi.mock("next/navigation", () => ({
	redirect: (value: string) => {
		throw new Error(`redirect:${value}`);
	},
	notFound: () => {
		throw new Error("not-found");
	},
}));

import CapsPage from "@/app/(org)/dashboard/caps/page";
import { getDashboardData } from "@/app/(org)/dashboard/dashboard-data";
import SharedCapsPage from "@/app/(org)/dashboard/spaces/[spaceId]/page";
import { getVideosByFolderId } from "@/lib/folder";
import {
	getInviteDetails,
	getPendingInviteIdForUser,
} from "@/lib/organization-invite-read";
import { runPromise } from "@/lib/server";

let fixture: Awaited<ReturnType<typeof createTestDatabase>>;
let owner: Awaited<ReturnType<typeof createTestOwner>>;
let other: Awaited<ReturnType<typeof createTestOwner>>;
const addVideo = async (input: Partial<typeof videos.$inferInsert> = {}) => {
	const value = {
		id: nanoId() as typeof videos.$inferInsert.id,
		ownerId: owner.id,
		orgId: owner.activeOrganizationId,
		name: "Recording",
		source: { type: "webMP4" } as const,
		...input,
	};
	await fixture.database.insert(videos).values(value);
	return value;
};

describe("dashboard boot reads on D1", () => {
	beforeAll(async () => {
		process.env.CAP_RUNTIME = "cloudflare";
		fixture = await createTestDatabase();
		state.database = fixture.database;
	});
	afterAll(async () => fixture?.dispose());
	beforeEach(async () => {
		owner = await createTestOwner(fixture.database);
		other = await createTestOwner(fixture.database);
		state.user = owner;
	});
	it("loads an owner's organization and private/public spaces without MySQL", async () => {
		const ownSpace = nanoId() as typeof spaces.$inferInsert.id;
		const hiddenSpace = nanoId() as typeof spaces.$inferInsert.id;
		const publicSpace = nanoId() as typeof spaces.$inferInsert.id;
		await fixture.database.insert(spaces).values([
			{
				id: ownSpace,
				organizationId: owner.activeOrganizationId,
				createdById: owner.id,
				name: "Own private",
				privacy: "Private",
			},
			{
				id: hiddenSpace,
				organizationId: owner.activeOrganizationId,
				createdById: other.id,
				name: "Other private",
				privacy: "Private",
			},
			{
				id: publicSpace,
				organizationId: owner.activeOrganizationId,
				createdById: other.id,
				name: "Team",
				privacy: "Public",
			},
		]);
		const data = await getDashboardData(owner);
		expect(data.organizationSelect.map((row) => row.organization.id)).toEqual([
			owner.activeOrganizationId,
		]);
		expect(data.organizationSelect[0]?.hasActiveProSeatProvider).toBe(true);
		expect(data.spacesData.map((row) => row.id)).toEqual(
			expect.arrayContaining([
				owner.activeOrganizationId,
				ownSpace,
				publicSpace,
			]),
		);
		expect(data.spacesData.some((row) => row.id === hiddenSpace)).toBe(false);
	});
	it("personal pagination counts only owned root videos and decodes the organization DTO once", async () => {
		const folderId = nanoId() as typeof folders.$inferInsert.id;
		await fixture.database.insert(folders).values({
			id: folderId,
			name: "Nested",
			organizationId: owner.activeOrganizationId,
			createdById: owner.id,
		});
		const root = await addVideo();
		await addVideo({ folderId });
		await addVideo({ ownerId: other.id });
		await addVideo({ orgId: other.activeOrganizationId });
		await fixture.database.insert(comments).values([
			{
				id: nanoId() as typeof comments.$inferInsert.id,
				type: "text",
				content: "First",
				authorId: owner.id,
				videoId: root.id,
			},
			{
				id: nanoId() as typeof comments.$inferInsert.id,
				type: "text",
				content: "Second",
				authorId: owner.id,
				videoId: root.id,
			},
			{
				id: nanoId() as typeof comments.$inferInsert.id,
				type: "emoji",
				content: "Like",
				authorId: owner.id,
				videoId: root.id,
			},
		]);
		const page = await CapsPage({
			params: Promise.resolve({}),
			searchParams: Promise.resolve({}),
		});
		expect(page.props.count).toBe(1);
		expect(page.props.data).toHaveLength(1);
		expect(page.props.data[0]).toMatchObject({
			id: root.id,
			totalComments: 2,
			totalReactions: 1,
			sharedOrganizations: [{ id: owner.activeOrganizationId }],
		});
		expect(page.props.data[0]?.sharedOrganizations).toHaveLength(1);
	});
	it("organization pagination uses shared-folder placement rather than the video's personal folder", async () => {
		const folderId = nanoId() as typeof folders.$inferInsert.id;
		await fixture.database.insert(folders).values({
			id: folderId,
			name: "Nested",
			organizationId: owner.activeOrganizationId,
			createdById: owner.id,
		});
		const sharedRoot = await addVideo({ folderId });
		const nestedShare = await addVideo();
		await fixture.database.insert(sharedVideos).values([
			{
				id: nanoId(),
				videoId: sharedRoot.id,
				organizationId: owner.activeOrganizationId,
				sharedByUserId: owner.id,
				folderId: null,
			},
			{
				id: nanoId(),
				videoId: nestedShare.id,
				organizationId: owner.activeOrganizationId,
				sharedByUserId: owner.id,
				folderId,
			},
		]);
		const page = await SharedCapsPage({
			params: Promise.resolve({ spaceId: owner.activeOrganizationId }),
			searchParams: Promise.resolve({}),
		});
		expect(page?.props.count).toBe(1);
		expect(page?.props.data.map((row: { id: string }) => row.id)).toEqual([
			sharedRoot.id,
		]);
	});
	it("decodes folder sharing aggregates and supports more than100 video IDs", async () => {
		const folderId = nanoId() as typeof folders.$inferInsert.id;
		await fixture.database
			.insert(folders)
			.values({
				id: folderId,
				name: "Many recordings",
				organizationId: owner.activeOrganizationId,
				createdById: owner.id,
			});
		const ids = Array.from(
			{ length: 101 },
			() => nanoId() as typeof videos.$inferInsert.id,
		);
		for (let offset = 0; offset < ids.length; offset += 30) {
			const batch = ids
				.slice(offset, offset + 30)
				.map((id) =>
					fixture.database
						.insert(videos)
						.values({
							id,
							ownerId: owner.id,
							orgId: owner.activeOrganizationId,
							name: "Folder recording",
							source: { type: "webMP4" },
							folderId,
						}),
				);
			const first = batch[0];
			if (first) await fixture.database.batch([first, ...batch.slice(1)]);
		}
		const firstId = ids[0];
		if (!firstId) throw new Error("Missing video");
		await fixture.database
			.insert(sharedVideos)
			.values({
				id: nanoId(),
				videoId: firstId,
				organizationId: owner.activeOrganizationId,
				sharedByUserId: owner.id,
			});
		await fixture.database.insert(comments).values([
			{
				id: nanoId() as typeof comments.$inferInsert.id,
				type: "text",
				content: "One",
				authorId: owner.id,
				videoId: firstId,
			},
			{
				id: nanoId() as typeof comments.$inferInsert.id,
				type: "text",
				content: "Two",
				authorId: owner.id,
				videoId: firstId,
			},
		]);
		const result = await runPromise(
			getVideosByFolderId(folderId, { variant: "user" }),
		);
		expect(result).toHaveLength(101);
		expect(
			result.find((row) => row.id === firstId)?.sharedOrganizations,
		).toEqual([expect.objectContaining({ id: owner.activeOrganizationId })]);
	});
	it("omits shared recordings whose source organization is being deleted", async () => {
		const recording = await addVideo({
			ownerId: other.id,
			orgId: other.activeOrganizationId,
		});
		await fixture.database.insert(sharedVideos).values({
			id: nanoId(),
			videoId: recording.id,
			organizationId: owner.activeOrganizationId,
			sharedByUserId: other.id,
		});
		await fixture.database
			.update(organizations)
			.set({ tombstoneAt: new Date() })
			.where(eq(organizations.id, other.activeOrganizationId));
		const page = await SharedCapsPage({
			params: Promise.resolve({ spaceId: owner.activeOrganizationId }),
			searchParams: Promise.resolve({}),
		});
		expect(page?.props.count).toBe(0);
		expect(page?.props.data).toEqual([]);
	});
	it("does not expose another organization or a tombstoned organization", async () => {
		await expect(
			SharedCapsPage({
				params: Promise.resolve({ spaceId: other.activeOrganizationId }),
				searchParams: Promise.resolve({}),
			}),
		).rejects.toThrow("not-found");
		await fixture.database
			.update(organizations)
			.set({ tombstoneAt: new Date() })
			.where(eq(organizations.id, owner.activeOrganizationId));
		expect((await getDashboardData(owner)).organizationSelect).toEqual([]);
		await expect(
			SharedCapsPage({
				params: Promise.resolve({ spaceId: owner.activeOrganizationId }),
				searchParams: Promise.resolve({}),
			}),
		).rejects.toThrow("not-found");
	});
	it("ignores expired, revoked and tombstoned invitations in boot redirects and invitation pages", async () => {
		const ids = [nanoId(), nanoId(), nanoId(), nanoId()];
		const [expired, revoked, tombstone, active] = ids;
		if (!expired || !revoked || !tombstone || !active)
			throw new Error("Missing fixture IDs");
		await fixture.database.insert(organizationInvites).values([
			{
				id: expired,
				organizationId: owner.activeOrganizationId,
				invitedByUserId: owner.id,
				invitedEmail: owner.email,
				role: "member",
				expiresAt: new Date(0),
			},
			{
				id: revoked,
				organizationId: owner.activeOrganizationId,
				invitedByUserId: owner.id,
				invitedEmail: owner.email,
				role: "member",
				status: "declined",
			},
			{
				id: tombstone,
				organizationId: other.activeOrganizationId,
				invitedByUserId: other.id,
				invitedEmail: owner.email,
				role: "member",
			},
			{
				id: active,
				organizationId: owner.activeOrganizationId,
				invitedByUserId: owner.id,
				invitedEmail: owner.email,
				role: "member",
				expiresAt: new Date(Date.now() + 60_000),
			},
		]);
		await fixture.database
			.update(organizations)
			.set({ tombstoneAt: new Date() })
			.where(eq(organizations.id, other.activeOrganizationId));
		expect(await getPendingInviteIdForUser(owner.email.toUpperCase())).toBe(
			active,
		);
		for (const id of [expired, revoked, tombstone])
			expect(await getInviteDetails(id)).toBeUndefined();
		expect((await getInviteDetails(active))?.invite.id).toBe(active);
		expect(
			(await getDashboardData(owner)).organizationSelect[0]?.invites.map(
				(row) => row.id,
			),
		).toEqual([active]);
	});
});
