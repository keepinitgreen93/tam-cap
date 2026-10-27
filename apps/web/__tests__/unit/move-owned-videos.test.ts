import { createCloudflareDb } from "@cap/database/cloudflare";
import {
	createD1BridgeBinding,
	handleD1BridgeRequest,
} from "@cap/database/cloudflare/bridge";
import * as Db from "@cap/database/cloudflare/schema";
import { Folder, Organisation, Space, User, Video } from "@cap/web-domain";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, expect, it, vi } from "vitest";
import { createTestDatabase } from "../../../../packages/database/cloudflare/test-runtime";

const state = vi.hoisted(() => ({
	database: undefined as ReturnType<typeof createCloudflareDb> | undefined,
	user: undefined as
		| { id: User.UserId; activeOrganizationId: Organisation.OrganisationId }
		| undefined,
	revalidate: vi.fn(),
	reads: [] as string[],
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
vi.mock("next/cache", () => ({ revalidatePath: state.revalidate }));

import {
	getOwnedVideoMoveDestinations,
	placeOwnedVideos,
} from "@/actions/folders/move-items";

let runtime: Awaited<ReturnType<typeof createTestDatabase>>,
	sequence = 0;
beforeAll(async () => {
	runtime = await createTestDatabase();
	state.database = createCloudflareDb(
		createD1BridgeBinding({
			fetch: async (request) => {
				const payload = (await request.clone().json()) as {
					operation: string;
					statement?: { sql: string };
				};
				if (payload.statement) state.reads.push(payload.statement.sql);
				return handleD1BridgeRequest(request, runtime.binding);
			},
		}),
	);
}, 60000);
afterAll(async () => runtime?.dispose());
async function fixture() {
	const s = String(++sequence),
		owner = User.UserId.make(`mvowner${s}`),
		admin = User.UserId.make(`mvadmin${s}`),
		org = Organisation.OrganisationId.make(`mvorg${s}`),
		space = Space.SpaceId.make(`mvspace${s}`),
		personal = Folder.FolderId.make(`mvpersonal${s}`),
		team = Folder.FolderId.make(`mvteam${s}`),
		spaceFolder = Folder.FolderId.make(`mvsfolder${s}`),
		otherPersonal = Folder.FolderId.make(`mvother${s}`),
		ids = [
			Video.VideoId.make(`mvone${s}`),
			Video.VideoId.make(`mvtwo${s}`),
		] as const;
	await runtime.database.insert(Db.users).values([
		{ id: owner, email: `${s}owner@moves.test`, activeOrganizationId: org },
		{ id: admin, email: `${s}admin@moves.test`, activeOrganizationId: org },
	]);
	await runtime.database
		.insert(Db.organizations)
		.values({ id: org, ownerId: admin, name: "Moves" });
	await runtime.database.insert(Db.organizationMembers).values({
		id: `mvmember${s}`,
		organizationId: org,
		userId: owner,
		role: "member",
	});
	await runtime.database.insert(Db.spaces).values({
		id: space,
		organizationId: org,
		createdById: admin,
		name: "Team space",
		privacy: "Private",
	});
	await runtime.database
		.insert(Db.spaceMembers)
		.values({ id: `mvsm${s}`, spaceId: space, userId: owner, role: "member" });
	await runtime.database.insert(Db.folders).values([
		{
			id: personal,
			organizationId: org,
			createdById: owner,
			spaceId: null,
			name: "Personal",
		},
		{
			id: team,
			organizationId: org,
			createdById: admin,
			spaceId: org,
			name: "Team folder",
		},
		{
			id: spaceFolder,
			organizationId: org,
			createdById: admin,
			spaceId: space,
			name: "Space folder",
		},
		{
			id: otherPersonal,
			organizationId: org,
			createdById: admin,
			spaceId: null,
			name: "Other personal",
		},
	]);
	await runtime.database.insert(Db.videos).values(
		ids.map((id) => ({
			id,
			orgId: org,
			ownerId: owner,
			folderId: personal,
			name: "Recording",
			public: false,
			source: { type: "webMP4" as const },
		})),
	);
	state.user = { id: owner, activeOrganizationId: org };
	state.reads = [];
	state.revalidate.mockReset();
	const shares = () =>
		runtime.database
			.select()
			.from(Db.sharedVideos)
			.where(eq(Db.sharedVideos.organizationId, org));
	const spaceShares = () =>
		runtime.database
			.select()
			.from(Db.spaceVideos)
			.where(eq(Db.spaceVideos.spaceId, space));
	return {
		s,
		owner,
		admin,
		org,
		space,
		personal,
		team,
		spaceFolder,
		otherPersonal,
		ids,
		shares,
		spaceShares,
	};
}
it("adds missing team shares, moves existing shares, and preserves personal placement", async () => {
	const f = await fixture();
	await runtime.database.insert(Db.sharedVideos).values({
		id: "existing-share",
		videoId: f.ids[0],
		organizationId: f.org,
		sharedByUserId: f.owner,
	});
	expect(
		await placeOwnedVideos({
			videoIds: [...f.ids],
			folderId: f.team,
			location: { type: "organization" },
		}),
	).toEqual({ moved: 2 });
	const rows = await f.shares();
	expect(rows).toHaveLength(2);
	expect(rows.find((row) => row.videoId === f.ids[0])?.id).toBe(
		"existing-share",
	);
	expect(rows.every((row) => row.folderId === f.team)).toBe(true);
	expect(
		(
			await runtime.database
				.select()
				.from(Db.videos)
				.where(eq(Db.videos.ownerId, f.owner))
		).every((row) => row.folderId === f.personal),
	).toBe(true);
	expect(state.revalidate).toHaveBeenCalledWith("/s/[videoId]", "page");
});
it("lets space members place their own Caps without changing other shares", async () => {
	const f = await fixture();
	await runtime.database.insert(Db.sharedVideos).values({
		id: "preserve-share",
		videoId: f.ids[0],
		organizationId: f.org,
		sharedByUserId: f.owner,
	});
	await placeOwnedVideos({
		videoIds: [f.ids[0]],
		folderId: f.spaceFolder,
		location: { type: "space", spaceId: f.space },
	});
	expect(await f.spaceShares()).toMatchObject([
		{ videoId: f.ids[0], spaceId: f.space, folderId: f.spaceFolder },
	]);
	expect(await f.shares()).toHaveLength(1);
});
it.each(["deleted", "revoked"] as const)(
	"rechecks space access when the space is %s",
	async (reason) => {
		const f = await fixture();
		if (reason === "deleted")
			await runtime.database.delete(Db.spaces).where(eq(Db.spaces.id, f.space));
		else
			await runtime.database
				.delete(Db.spaceMembers)
				.where(eq(Db.spaceMembers.userId, f.owner));
		await expect(
			placeOwnedVideos({
				videoIds: [f.ids[0]],
				folderId: f.spaceFolder,
				location: { type: "space", spaceId: f.space },
			}),
		).rejects.toThrow(
			reason === "deleted" ? "Space not found" : "Unauthorized",
		);
		expect(await f.spaceShares()).toEqual([]);
	},
);
it.each(["admin", "creator"] as const)(
	"keeps space access for an organization %s without a space membership row",
	async (role) => {
		const f = await fixture();
		await runtime.database
			.delete(Db.spaceMembers)
			.where(eq(Db.spaceMembers.userId, f.owner));
		if (role === "admin")
			await runtime.database
				.update(Db.organizationMembers)
				.set({ role: "admin" })
				.where(eq(Db.organizationMembers.userId, f.owner));
		else
			await runtime.database
				.update(Db.spaces)
				.set({ createdById: f.owner })
				.where(eq(Db.spaces.id, f.space));
		expect(
			await placeOwnedVideos({
				videoIds: [f.ids[0]],
				folderId: null,
				location: { type: "space", spaceId: f.space },
			}),
		).toEqual({ moved: 1 });
		expect(await f.spaceShares()).toHaveLength(1);
	},
);
it("does not duplicate an existing placement on retry", async () => {
	const f = await fixture();
	const input = {
		videoIds: [f.ids[0]],
		folderId: null,
		location: { type: "organization" as const },
	};
	await placeOwnedVideos(input);
	const before = await f.shares();
	await placeOwnedVideos(input);
	expect(await f.shares()).toEqual(before);
});
it("rejects the whole selection if any Cap is not owned in the active organization", async () => {
	const f = await fixture();
	await runtime.database
		.update(Db.videos)
		.set({ ownerId: f.admin })
		.where(eq(Db.videos.id, f.ids[1]));
	await expect(
		placeOwnedVideos({
			videoIds: [...f.ids],
			folderId: f.team,
			location: { type: "organization" },
		}),
	).rejects.toThrow("cannot be moved");
	expect(await f.shares()).toEqual([]);
});
it("rejects a folder outside the selected destination", async () => {
	const f = await fixture();
	await expect(
		placeOwnedVideos({
			videoIds: [f.ids[0]],
			folderId: f.spaceFolder,
			location: { type: "organization" },
		}),
	).rejects.toThrow("Destination folder not found");
	expect(await f.shares()).toEqual([]);
});
it.each([
	"missing",
	"foreign-organization",
	"no-space-membership",
	"no-organization-membership",
] as const)("rejects an inaccessible space (%s)", async (reason) => {
	const f = await fixture();
	if (reason === "missing")
		await runtime.database.delete(Db.spaces).where(eq(Db.spaces.id, f.space));
	if (reason === "foreign-organization") {
		const other = Organisation.OrganisationId.make("foreign-org");
		await runtime.database
			.insert(Db.organizations)
			.values({ id: other, ownerId: f.admin, name: "Foreign" });
		await runtime.database
			.update(Db.spaces)
			.set({ organizationId: other })
			.where(eq(Db.spaces.id, f.space));
	}
	if (reason === "no-space-membership")
		await runtime.database
			.delete(Db.spaceMembers)
			.where(eq(Db.spaceMembers.userId, f.owner));
	if (reason === "no-organization-membership")
		await runtime.database
			.delete(Db.organizationMembers)
			.where(eq(Db.organizationMembers.userId, f.owner));
	await expect(
		placeOwnedVideos({
			videoIds: [...f.ids],
			folderId: f.spaceFolder,
			location: { type: "space", spaceId: f.space },
		}),
	).rejects.toThrow();
	expect(await f.spaceShares()).toEqual([]);
	expect(await f.shares()).toEqual([]);
});
it("rejects former organization members before reading or writing placements", async () => {
	const f = await fixture();
	await runtime.database
		.delete(Db.organizationMembers)
		.where(eq(Db.organizationMembers.userId, f.owner));
	state.reads = [];
	await expect(
		placeOwnedVideos({
			videoIds: [...f.ids],
			folderId: f.team,
			location: { type: "organization" },
		}),
	).rejects.toThrow("Organization membership is required");
	expect(state.reads.some((sql) => sql.includes('from "videos"'))).toBe(false);
	expect(await f.shares()).toEqual([]);
});
it("limits selectable folders to personal and accessible team locations", async () => {
	const f = await fixture(),
		groups = await getOwnedVideoMoveDestinations();
	expect(
		groups.map((group) => [
			group.name,
			group.folders.map((folder) => folder.id),
		]),
	).toEqual([
		["My Caps", [f.personal]],
		["All team members", [f.team]],
		["Team space", [f.spaceFolder]],
	]);
	expect(
		groups.flatMap((group) => group.folders.map((folder) => folder.id)),
	).not.toContain(f.otherPersonal);
});
it("scopes every check and write to a requested organization the owner belongs to", async () => {
	const first = await fixture(),
		requested = await fixture();
	state.user = { id: requested.owner, activeOrganizationId: first.org };
	expect(
		await placeOwnedVideos({
			videoIds: [requested.ids[0]],
			folderId: requested.team,
			location: { type: "organization" },
			organizationId: requested.org,
		}),
	).toEqual({ moved: 1 });
	expect(await requested.shares()).toMatchObject([
		{
			videoId: requested.ids[0],
			organizationId: requested.org,
			folderId: requested.team,
		},
	]);
	expect(await first.shares()).toEqual([]);
});
it("rejects a requested organization the owner no longer belongs to", async () => {
	const first = await fixture(),
		requested = await fixture();
	state.user = { id: first.owner, activeOrganizationId: first.org };
	await expect(getOwnedVideoMoveDestinations(requested.org)).rejects.toThrow(
		"Forbidden",
	);
	await expect(
		placeOwnedVideos({
			videoIds: [first.ids[0]],
			folderId: null,
			location: { type: "personal" },
			organizationId: requested.org,
		}),
	).rejects.toThrow("Organization membership is required");
	expect(await first.shares()).toEqual([]);
	expect(await requested.shares()).toEqual([]);
});
it("lists destinations in a requested organization", async () => {
	const active = await fixture(),
		requested = await fixture();
	state.user = { id: requested.owner, activeOrganizationId: active.org };
	const groups = await getOwnedVideoMoveDestinations(requested.org);
	expect(
		groups.flatMap((group) => group.folders.map((folder) => folder.id)),
	).toEqual([requested.personal, requested.team, requested.spaceFolder]);
});
it("keeps personal moves private and checks personal folder ownership", async () => {
	const f = await fixture();
	await expect(
		placeOwnedVideos({
			videoIds: [f.ids[0]],
			folderId: f.otherPersonal,
			location: { type: "personal" },
		}),
	).rejects.toThrow("Destination folder not found");
	const target = Folder.FolderId.make("mine-dest");
	await runtime.database.insert(Db.folders).values({
		id: target,
		organizationId: f.org,
		createdById: f.owner,
		name: "Mine",
	});
	await placeOwnedVideos({
		videoIds: [f.ids[0]],
		folderId: target,
		location: { type: "personal" },
	});
	const [row] = await runtime.database
		.select()
		.from(Db.videos)
		.where(eq(Db.videos.id, f.ids[0]));
	expect(row).toMatchObject({
		folderId: target,
		ownerId: f.owner,
		public: false,
	});
	expect(await f.shares()).toEqual([]);
	expect(await f.spaceShares()).toEqual([]);
});
