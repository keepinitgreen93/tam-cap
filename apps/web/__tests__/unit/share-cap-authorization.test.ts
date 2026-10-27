import { createCloudflareDb } from "@cap/database/cloudflare";
import {
	createD1BridgeBinding,
	handleD1BridgeRequest,
} from "@cap/database/cloudflare/bridge";
import * as Db from "@cap/database/cloudflare/schema";
import { Organisation, Space, User, Video } from "@cap/web-domain";
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
	fail: false,
	queries: 0,
}));
vi.mock("@cap/database/cloudflare/application", () => ({
	db: () => {
		if (!state.database) throw Error("Missing fixture");
		return state.database;
	},
}));
vi.mock("@cap/database/auth/session", () => ({ getCurrentUser: state.user }));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));

import { shareCap } from "@/actions/caps/share";

let runtime: Awaited<ReturnType<typeof createTestDatabase>>;
let sequence = 0;
let capId: Video.VideoId,
	spaceId: Space.SpaceId,
	orgId: Organisation.OrganisationId,
	caller: User.UserId;
beforeAll(async () => {
	runtime = await createTestDatabase();
	state.database = createCloudflareDb(
		createD1BridgeBinding({
			fetch: async (request) => {
				state.queries++;
				const payload = (await request.clone().json()) as {
					statements?: { sql: string }[];
					sql?: string;
				};
				if (state.fail && JSON.stringify(payload).includes('from "spaces"'))
					throw Error("Database unavailable");
				return handleD1BridgeRequest(request, runtime.binding);
			},
		}),
	);
}, 60000);
afterAll(async () => runtime?.dispose());
beforeEach(async () => {
	const s = String(++sequence);
	state.fail = false;
	state.queries = 0;
	capId = Video.VideoId.make(`sharev${s}`);
	spaceId = Space.SpaceId.make(`shares${s}`);
	orgId = Organisation.OrganisationId.make(`shareo${s}`);
	caller = User.UserId.make(`caller${s}`);
	const ownerId = User.UserId.make(`owner${s}`);
	await runtime.database.insert(Db.users).values([
		{
			id: caller,
			email: `${s}caller@test.invalid`,
			activeOrganizationId: orgId,
		},
		{
			id: ownerId,
			email: `${s}owner@test.invalid`,
			activeOrganizationId: orgId,
		},
	]);
	await runtime.database
		.insert(Db.organizations)
		.values({ id: orgId, ownerId, name: "Organization" });
	await runtime.database.insert(Db.organizationMembers).values({
		id: `m${s}`,
		organizationId: orgId,
		userId: caller,
		role: "member",
	});
	await runtime.database.insert(Db.spaces).values({
		id: spaceId,
		organizationId: orgId,
		createdById: ownerId,
		name: "Private",
		privacy: "Private",
	});
	await runtime.database.insert(Db.videos).values({
		id: capId,
		ownerId: caller,
		orgId,
		name: "Video",
		source: { type: "webMP4" },
		public: false,
	});
	state.user.mockResolvedValue({ id: caller });
	vi.spyOn(console, "error").mockImplementation(() => undefined);
});
async function snapshot() {
	return {
		video: await runtime.database
			.select()
			.from(Db.videos)
			.where(eq(Db.videos.id, capId)),
		space: await runtime.database
			.select()
			.from(Db.spaceVideos)
			.where(eq(Db.spaceVideos.videoId, capId)),
		organization: await runtime.database
			.select()
			.from(Db.sharedVideos)
			.where(eq(Db.sharedVideos.videoId, capId)),
	};
}
async function assertShared() {
	expect(await shareCap({ capId, spaceIds: [spaceId] })).toEqual({
		success: true,
	});
	expect((await snapshot()).space).toMatchObject([
		{ videoId: capId, spaceId, addedById: caller },
	]);
}
describe("sharing Caps to private spaces", () => {
	it("rejects an organization member outside the space before changing any shares or visibility", async () => {
		await runtime.database.insert(Db.sharedVideos).values({
			id: "orgshare",
			videoId: capId,
			organizationId: orgId,
			sharedByUserId: caller,
		});
		const before = await snapshot();
		expect(
			await shareCap({ capId, spaceIds: [spaceId], public: true }),
		).toMatchObject({ success: false });
		expect(await snapshot()).toEqual(before);
	});
	it("rejects a missing space access row without writing", async () => {
		await runtime.database.delete(Db.spaces).where(eq(Db.spaces.id, spaceId));
		const before = await snapshot();
		expect(await shareCap({ capId, spaceIds: [spaceId] })).toEqual({
			success: false,
			error: "Unauthorized",
		});
		expect(await snapshot()).toEqual(before);
	});
	it("does not write when the space access query fails", async () => {
		const before = await snapshot();
		state.fail = true;
		expect(await shareCap({ capId, spaceIds: [spaceId] })).toMatchObject({
			success: false,
		});
		state.fail = false;
		expect(await snapshot()).toEqual(before);
	});
	it.each(["member", "admin"] as const)("allows a space %s", async (role) => {
		await runtime.database
			.insert(Db.spaceMembers)
			.values({ id: `sm${sequence}`, spaceId, userId: caller, role });
		await assertShared();
	});
	it("allows the space creator without a space membership row", async () => {
		await runtime.database
			.update(Db.spaces)
			.set({ createdById: caller })
			.where(eq(Db.spaces.id, spaceId));
		await assertShared();
	});
	it("allows an organization admin without a space membership row", async () => {
		await runtime.database
			.update(Db.organizationMembers)
			.set({ role: "admin" })
			.where(eq(Db.organizationMembers.userId, caller));
		await assertShared();
	});
	it("preserves sharing to an organization-visible space", async () => {
		await runtime.database
			.update(Db.spaces)
			.set({ privacy: "Public" })
			.where(eq(Db.spaces.id, spaceId));
		await assertShared();
	});
	it("keeps an existing private space share when access was since removed", async () => {
		await runtime.database.insert(Db.spaceVideos).values({
			id: `existing${sequence}`,
			videoId: capId,
			spaceId,
			addedById: caller,
		});
		const before = await snapshot();
		expect(await shareCap({ capId, spaceIds: [spaceId] })).toEqual({
			success: true,
		});
		expect(await snapshot()).toEqual(before);
	});
	it("rejects unauthenticated callers without querying the database", async () => {
		state.user.mockResolvedValue(null);
		state.queries = 0;
		expect(await shareCap({ capId, spaceIds: [spaceId] })).toEqual({
			success: false,
			error: "Unauthorized",
		});
		expect(state.queries).toBe(0);
	});
	it("still rejects another user's video", async () => {
		await runtime.database
			.update(Db.videos)
			.set({ ownerId: User.UserId.make("another-user") })
			.where(eq(Db.videos.id, capId));
		const before = await snapshot();
		expect(await shareCap({ capId, spaceIds: [spaceId] })).toEqual({
			success: false,
			error: "Unauthorized",
		});
		expect(await snapshot()).toEqual(before);
	});
	it("allows clearing sharing without a destination space", async () => {
		await runtime.database.insert(Db.spaceVideos).values({
			id: `clear${sequence}`,
			videoId: capId,
			spaceId,
			addedById: caller,
		});
		expect(await shareCap({ capId, spaceIds: [] })).toEqual({ success: true });
		expect((await snapshot()).space).toEqual([]);
	});
});
