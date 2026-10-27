import { createCloudflareDb } from "@cap/database/cloudflare";
import {
	createD1BridgeBinding,
	handleD1BridgeRequest,
} from "@cap/database/cloudflare/bridge";
import * as Db from "@cap/database/cloudflare/schema";
import { Folder, Organisation, Space, User, Video } from "@cap/web-domain";
import { and, eq } from "drizzle-orm";
import { afterAll, beforeAll, expect, it, vi } from "vitest";
import { createTestDatabase } from "../../../../packages/database/cloudflare/test-runtime";

const state = vi.hoisted(() => ({
	database: undefined as ReturnType<typeof createCloudflareDb> | undefined,
	user: undefined as
		| { id: User.UserId; activeOrganizationId: Organisation.OrganisationId }
		| undefined,
}));
vi.mock("@cap/database/cloudflare/application", () => ({
	db: () => {
		if (!state.database) throw Error("Missing fixture");
		return state.database;
	},
}));
vi.mock("@cap/database/auth/session", () => ({
	getCurrentUser: async () => state.user,
}));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));

import { shareCap } from "@/actions/caps/share";
import { addVideosToFolder } from "@/actions/folders/add-videos";
import {
	moveFolder,
	moveVideos,
	placeOwnedVideos,
} from "@/actions/folders/move-items";
import { removeVideosFromFolder } from "@/actions/folders/remove-videos";

let runtime: Awaited<ReturnType<typeof createTestDatabase>>,
	beforeBatch: (() => Promise<void>) | undefined,
	sequence = 0;
beforeAll(async () => {
	runtime = await createTestDatabase();
	state.database = createCloudflareDb(
		createD1BridgeBinding({
			fetch: async (request) => {
				const payload = (await request.clone().json()) as { operation: string };
				if (payload.operation === "batch" && beforeBatch) {
					const hook = beforeBatch;
					beforeBatch = undefined;
					await hook();
				}
				return handleD1BridgeRequest(request, runtime.binding);
			},
		}),
	);
}, 60000);
afterAll(async () => runtime?.dispose());
async function fixture(count = 1) {
	const suffix = String(++sequence),
		ownerId = User.UserId.make(`sowner${suffix}`),
		orgId = Organisation.OrganisationId.make(`sorg${suffix}`),
		spaceId = Space.SpaceId.make(`space${suffix}`),
		folderId = Folder.FolderId.make(`folder${suffix}`),
		ids = Array.from({ length: count }, (_, index) =>
			Video.VideoId.make(`v${suffix}-${index}`),
		);
	await runtime.database
		.insert(Db.users)
		.values({
			id: ownerId,
			email: `${suffix}@sharing.test`,
			activeOrganizationId: orgId,
		});
	await runtime.database
		.insert(Db.organizations)
		.values({ id: orgId, ownerId, name: "Sharing" });
	await runtime.database
		.insert(Db.spaces)
		.values({
			id: spaceId,
			organizationId: orgId,
			createdById: ownerId,
			name: "Private space",
		});
	await runtime.database
		.insert(Db.folders)
		.values({
			id: folderId,
			organizationId: orgId,
			createdById: ownerId,
			name: "Folder",
			spaceId,
		});
	await runtime.binding
		.prepare(
			'INSERT INTO videos (id, ownerId, orgId, source) SELECT value, ?, ?, \'{"type":"webMP4"}\' FROM json_each(?)',
		)
		.bind(ownerId, orgId, JSON.stringify(ids))
		.run();
	state.user = { id: ownerId, activeOrganizationId: orgId };
	const videoId = ids[0];
	if (!videoId) throw Error("Missing fixture video");
	return { ownerId, orgId, spaceId, folderId, ids, videoId };
}
it("500-video folder additions and moves remain one atomic set operation without duplicate shares", async () => {
	const f = await fixture(500);
	const results = await Promise.all([
		addVideosToFolder(f.folderId, f.ids, f.spaceId),
		addVideosToFolder(f.folderId, f.ids, f.spaceId),
	]);
	expect(results.every((result) => result.success)).toBe(true);
	const rows = await runtime.database
		.select()
		.from(Db.spaceVideos)
		.where(eq(Db.spaceVideos.spaceId, f.spaceId));
	expect(rows).toHaveLength(500);
	expect(rows.every((row) => row.folderId === f.folderId)).toBe(true);
	await moveVideos({
		videoIds: f.ids,
		folderId: null,
		location: { type: "space", spaceId: f.spaceId },
	});
	const moved = await runtime.database
		.select()
		.from(Db.spaceVideos)
		.where(eq(Db.spaceVideos.spaceId, f.spaceId));
	expect(moved.every((row) => row.folderId === null)).toBe(true);
}, 30000);
it("revoking destination membership before commit prevents sharing and visibility changes", async () => {
	const f = await fixture();
	const member = User.UserId.make("smember");
	await runtime.database
		.insert(Db.users)
		.values({
			id: member,
			email: "member@sharing.test",
			activeOrganizationId: f.orgId,
		});
	await runtime.database
		.insert(Db.organizationMembers)
		.values({
			id: "smembership",
			organizationId: f.orgId,
			userId: member,
			role: "member",
		});
	await runtime.database
		.update(Db.videos)
		.set({ ownerId: member })
		.where(eq(Db.videos.id, f.videoId));
	await runtime.database
		.update(Db.spaces)
		.set({ privacy: "Public" })
		.where(eq(Db.spaces.id, f.spaceId));
	state.user = { id: member, activeOrganizationId: f.orgId };
	beforeBatch = async () => {
		await runtime.database
			.delete(Db.organizationMembers)
			.where(eq(Db.organizationMembers.userId, member));
	};
	const result = await shareCap({
		capId: f.videoId,
		spaceIds: [f.spaceId],
		public: true,
	});
	expect(result.success).toBe(false);
	expect(
		await runtime.database
			.select()
			.from(Db.spaceVideos)
			.where(eq(Db.spaceVideos.videoId, f.videoId)),
	).toEqual([]);
});
it("source ownership changes roll back folder placement", async () => {
	const f = await fixture();
	beforeBatch = async () => {
		await runtime.database
			.update(Db.videos)
			.set({ ownerId: User.UserId.make("other") })
			.where(eq(Db.videos.id, f.videoId));
	};
	await expect(
		placeOwnedVideos({
			videoIds: f.ids,
			folderId: f.folderId,
			location: { type: "space", spaceId: f.spaceId },
		}),
	).rejects.toThrow();
	expect(
		await runtime.database
			.select()
			.from(Db.spaceVideos)
			.where(eq(Db.spaceVideos.spaceId, f.spaceId)),
	).toEqual([]);
});
it("concurrent folder reparenting cannot create a cycle", async () => {
	const f = await fixture(),
		second = Folder.FolderId.make("secondfolder");
	await runtime.database
		.insert(Db.folders)
		.values({
			id: second,
			organizationId: f.orgId,
			createdById: f.ownerId,
			name: "Second",
			spaceId: f.spaceId,
		});
	const location = { type: "space" as const, spaceId: f.spaceId };
	const results = await Promise.allSettled([
		moveFolder({ folderId: f.folderId, parentId: second, location }),
		moveFolder({ folderId: second, parentId: f.folderId, location }),
	]);
	expect(
		results.filter((result) => result.status === "fulfilled"),
	).toHaveLength(1);
});
it("folder removal rejects a mismatched destination scope", async () => {
	const f = await fixture();
	await addVideosToFolder(f.folderId, f.ids, f.spaceId);
	const result = await removeVideosFromFolder(
		f.folderId,
		f.ids,
		Space.SpaceId.make("wrongspace"),
	);
	expect(result.success).toBe(false);
	expect(
		await runtime.database
			.select()
			.from(Db.spaceVideos)
			.where(
				and(
					eq(Db.spaceVideos.videoId, f.videoId),
					eq(Db.spaceVideos.folderId, f.folderId),
				),
			),
	).toHaveLength(1);
});
it("sharing to more than 48 spaces uses bounded bulk inserts", async () => {
	const f = await fixture();
	const ids = Array.from({ length: 60 }, (_, index) =>
		Space.SpaceId.make(`many${index}`),
	);
	await runtime.binding
		.prepare(
			"INSERT INTO spaces (id, name, organizationId, createdById) SELECT value, 'Space', ?, ? FROM json_each(?)",
		)
		.bind(f.orgId, f.ownerId, JSON.stringify(ids))
		.run();
	expect(await shareCap({ capId: f.videoId, spaceIds: ids })).toEqual({
		success: true,
	});
	expect(
		await runtime.database
			.select()
			.from(Db.spaceVideos)
			.where(eq(Db.spaceVideos.videoId, f.videoId)),
	).toHaveLength(60);
}, 30000);
