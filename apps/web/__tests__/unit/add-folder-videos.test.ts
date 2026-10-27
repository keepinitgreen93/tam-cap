import { createCloudflareDb } from "@cap/database/cloudflare";
import {
	createD1BridgeBinding,
	handleD1BridgeRequest,
} from "@cap/database/cloudflare/bridge";
import * as Db from "@cap/database/cloudflare/schema";
import { Folder, Organisation, Space, User, Video } from "@cap/web-domain";
import { eq } from "drizzle-orm";
import {
	afterAll,
	beforeAll,
	beforeEach,
	describe,
	expect,
	it,
	vi,
} from "vitest";
import { createTestDatabase } from "../../../../packages/database/cloudflare/test-runtime";

const state = vi.hoisted(() => ({
	database: undefined as ReturnType<typeof createCloudflareDb> | undefined,
	user: vi.fn(),
	failTable: "",
}));
vi.mock("@cap/database/cloudflare/application", () => ({
	db: () => {
		if (!state.database) throw Error("Missing fixture");
		return state.database;
	},
}));
vi.mock("@cap/database/auth/session", () => ({ getCurrentUser: state.user }));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));

import { addVideosToFolder } from "@/actions/folders/add-videos";

let runtime: Awaited<ReturnType<typeof createTestDatabase>>,
	sequence = 0;
beforeAll(async () => {
	runtime = await createTestDatabase();
	state.database = createCloudflareDb(
		createD1BridgeBinding({
			fetch: async (request) => {
				const payload = (await request.clone().json()) as {
					statement?: { sql: string };
				};
				if (
					state.failTable &&
					payload.statement?.sql.includes(`from "${state.failTable}"`)
				)
					throw Error("Database unavailable");
				return handleD1BridgeRequest(request, runtime.binding);
			},
		}),
	);
}, 60000);
afterAll(async () => runtime?.dispose());
beforeEach(() => {
	state.failTable = "";
	vi.spyOn(console, "error").mockImplementation(() => undefined);
});
describe.each(["space", "organization"] as const)(
	"adding videos to a %s folder",
	(kind) => {
		async function setup(ownedCount = 2, shared = false) {
			const s = String(++sequence),
				ownerId = User.UserId.make(`fowner${s}`),
				orgId = Organisation.OrganisationId.make(`forg${s}`),
				spaceId = Space.SpaceId.make(`fspace${s}`),
				folderId = Folder.FolderId.make(`ffolder${s}`),
				existingId = Video.VideoId.make(`existing${s}`),
				newId = Video.VideoId.make(`new${s}`);
			await runtime.database
				.insert(Db.users)
				.values({
					id: ownerId,
					email: `${s}folder@test.invalid`,
					activeOrganizationId: orgId,
				});
			await runtime.database
				.insert(Db.organizations)
				.values({ id: orgId, ownerId, name: "Folder organization" });
			await runtime.database.insert(Db.spaces).values({
				id: spaceId,
				organizationId: orgId,
				createdById: ownerId,
				name: "Folder space",
			});
			const targetId = kind === "space" ? spaceId : orgId;
			await runtime.database.insert(Db.folders).values({
				id: folderId,
				organizationId: orgId,
				spaceId: targetId,
				createdById: ownerId,
				name: "Destination",
			});
			await runtime.database.insert(Db.videos).values([
				{
					id: existingId,
					orgId,
					ownerId: ownedCount === 1 ? User.UserId.make("other") : ownerId,
					name: "Existing",
					source: { type: "webMP4" },
				},
				{ id: newId, orgId, ownerId, name: "New", source: { type: "webMP4" } },
			]);
			if (shared) {
				if (kind === "space")
					await runtime.database.insert(Db.spaceVideos).values({
						id: `fshare${s}`,
						spaceId,
						videoId: existingId,
						addedById: ownerId,
					});
				else
					await runtime.database.insert(Db.sharedVideos).values({
						id: `fshare${s}`,
						organizationId: orgId,
						videoId: existingId,
						sharedByUserId: ownerId,
					});
			}
			state.user.mockResolvedValue({
				id: ownerId,
				activeOrganizationId: orgId,
			});
			const rows = () =>
				kind === "space"
					? runtime.database
							.select()
							.from(Db.spaceVideos)
							.where(eq(Db.spaceVideos.spaceId, spaceId))
					: runtime.database
							.select()
							.from(Db.sharedVideos)
							.where(eq(Db.sharedVideos.organizationId, orgId));
			return {
				ownerId,
				orgId,
				spaceId,
				targetId,
				folderId,
				existingId,
				newId,
				rows,
			};
		}
		it("moves an existing share without inserting another sharing row", async () => {
			const f = await setup(2, true),
				before = await f.rows();
			expect(
				await addVideosToFolder(f.folderId, [f.existingId], f.targetId),
			).toMatchObject({ success: true, addedCount: 1 });
			const after = await f.rows();
			expect(after).toHaveLength(1);
			expect(after[0]).toMatchObject({
				id: before[0]?.id,
				videoId: f.existingId,
				folderId: f.folderId,
			});
		});
		it("inserts only missing shares when moving a mixed selection", async () => {
			const f = await setup(2, true),
				before = await f.rows();
			expect(
				await addVideosToFolder(
					f.folderId,
					[f.existingId, f.newId],
					f.targetId,
				),
			).toMatchObject({ success: true, addedCount: 2 });
			const after = await f.rows();
			expect(after).toHaveLength(2);
			expect(after.find((row) => row.videoId === f.existingId)?.id).toBe(
				before[0]?.id,
			);
			expect(after.every((row) => row.folderId === f.folderId)).toBe(true);
		});
		it("creates the share when the video is not in this collection", async () => {
			const f = await setup();
			expect(
				await addVideosToFolder(f.folderId, [f.newId], f.targetId),
			).toMatchObject({ success: true, addedCount: 1 });
			expect(await f.rows()).toMatchObject([
				{ videoId: f.newId, folderId: f.folderId },
			]);
		});
		it("does not share requested videos the caller does not own", async () => {
			const f = await setup(1);
			expect(
				await addVideosToFolder(
					f.folderId,
					[f.existingId, f.newId],
					f.targetId,
				),
			).toMatchObject({ success: true, addedCount: 1 });
			expect(await f.rows()).toMatchObject([
				{ videoId: f.newId, folderId: f.folderId },
			]);
		});
		it("rejects a caller without access to the collection", async () => {
			const f = await setup();
			state.user.mockResolvedValue({
				id: "outsider",
				activeOrganizationId: f.orgId,
			});
			expect(
				await addVideosToFolder(f.folderId, [f.newId], f.targetId),
			).toMatchObject({ success: false });
			expect(await f.rows()).toEqual([]);
		});
		it("rejects a folder that belongs to another organization", async () => {
			const f = await setup();
			await runtime.database
				.update(Db.folders)
				.set({ organizationId: Organisation.OrganisationId.make("other-org") })
				.where(eq(Db.folders.id, f.folderId));
			expect(
				await addVideosToFolder(f.folderId, [f.newId], f.targetId),
			).toMatchObject({ success: false });
			expect(await f.rows()).toEqual([]);
		});
		it("does not write when the sharing lookup fails", async () => {
			const f = await setup(2, true),
				before = await f.rows();
			state.failTable = kind === "space" ? "space_videos" : "shared_videos";
			expect(
				await addVideosToFolder(f.folderId, [f.existingId], f.targetId),
			).toMatchObject({ success: false });
			state.failTable = "";
			expect(await f.rows()).toEqual(before);
		});
	},
);
