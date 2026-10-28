import { createCloudflareDb } from "@cap/database/cloudflare";
import {
	createD1BridgeBinding,
	handleD1BridgeRequest,
} from "@cap/database/cloudflare/bridge";
import * as Db from "@cap/database/cloudflare/schema";
import type { VideosPolicy } from "@cap/web-backend/src/Videos/VideosPolicy";
import { Organisation, User, Video } from "@cap/web-domain";
import { eq } from "drizzle-orm";
import { Effect } from "effect";
import { afterAll, beforeAll, beforeEach, expect, it, vi } from "vitest";
import { createTestDatabase } from "../../../../packages/database/cloudflare/test-runtime";

const state = vi.hoisted(() => ({
	database: undefined as ReturnType<typeof createCloudflareDb> | undefined,
	user: null as typeof Db.users.$inferSelect | null,
	passwords: [] as string[],
	head: vi.fn(),
	sign: vi.fn(),
	beforeView: undefined as (() => Promise<void>) | undefined,
	videoReads: 0,
}));
vi.mock("server-only", () => ({}));
vi.mock("@cap/database/cloudflare/application", () => ({
	db: () => {
		if (!state.database) throw Error("Database missing");
		return state.database;
	},
}));
vi.mock("@cap/database/auth/session", () => ({
	getCurrentUser: async () => state.user,
}));
vi.mock("@cap/web-backend", () => ({
	Storage: {
		getAccessForVideo: () =>
			Effect.succeed([
				{
					headObject: state.head,
					getSignedObjectUrl: state.sign,
				},
			]),
	},
}));
vi.mock("@/lib/server", async () => {
	const { VideosPolicy } = await import(
		"../../../../packages/web-backend/src/Videos/VideosPolicy"
	);
	return {
		runPromise: <A, E>(effect: Effect.Effect<A, E, VideosPolicy>) =>
			Effect.runPromise(
				effect.pipe(
					Effect.provide(VideosPolicy.Default),
					Effect.provideService(Video.VideoPasswordAttachment, {
						passwords: state.passwords,
					}),
				),
			),
	};
});

import { getVideoDownloadInfo } from "@/actions/videos/download";

let runtime: Awaited<ReturnType<typeof createTestDatabase>>;
let owner: typeof Db.users.$inferSelect;
let member: typeof Db.users.$inferSelect;
let videoId: Video.VideoId;
let currentKey: string;
let originalKey: string;
let sequence = 0;

beforeAll(async () => {
	runtime = await createTestDatabase();
	state.database = createCloudflareDb(
		createD1BridgeBinding({
			fetch: async (request) => {
				const payload = (await request.clone().json()) as {
					operation: string;
					statement?: { sql: string };
				};
				if (
					payload.operation === "statement" &&
					payload.statement?.sql.includes('from "videos"')
				) {
					state.videoReads++;
					if (state.videoReads === 2 && state.beforeView) {
						const action = state.beforeView;
						state.beforeView = undefined;
						await action();
					}
				}
				return handleD1BridgeRequest(request, runtime.binding);
			},
		}),
	);
}, 60000);
afterAll(async () => runtime?.dispose());
beforeEach(async () => {
	const suffix = String(++sequence);
	const ownerId = User.UserId.make(`dlowner${suffix}`);
	const memberId = User.UserId.make(`dlmember${suffix}`);
	const orgId = Organisation.OrganisationId.make(`dlorg${suffix}`);
	videoId = Video.VideoId.make(`dlvideo${suffix}`);
	await runtime.database.insert(Db.users).values([
		{
			id: ownerId,
			email: `owner-${suffix}@download.test`,
			activeOrganizationId: orgId,
			emailVerified: new Date(),
		},
		{
			id: memberId,
			email: `member-${suffix}@download.test`,
			activeOrganizationId: orgId,
			emailVerified: new Date(),
		},
	]);
	await runtime.database
		.insert(Db.organizations)
		.values({ id: orgId, ownerId, name: "Download team" });
	await runtime.database.insert(Db.organizationMembers).values({
		id: `member-${suffix}`,
		organizationId: orgId,
		userId: memberId,
		role: "member",
	});
	currentKey = `${ownerId}/${videoId}/.recording/outputs/current/result.mp4`;
	originalKey = `${ownerId}/${videoId}/.recording/sources/original.mp4`;
	await runtime.database.insert(Db.videos).values({
		id: videoId,
		ownerId,
		orgId,
		name: "Edited recording",
		public: false,
		source: { type: "webMP4", outputKey: currentKey },
		metadata: {
			editingBase: {
				version: 1,
				id: crypto.randomUUID(),
				sourceKey: originalKey,
				duration: 10,
			},
		},
	});
	await runtime.database.insert(Db.sharedVideos).values({
		id: `share-${suffix}`,
		videoId,
		organizationId: orgId,
		sharedByUserId: ownerId,
	});
	const [loadedOwner] = await runtime.database
		.select()
		.from(Db.users)
		.where(eq(Db.users.id, ownerId));
	const [loadedMember] = await runtime.database
		.select()
		.from(Db.users)
		.where(eq(Db.users.id, memberId));
	if (!loadedOwner || !loadedMember) throw Error("Fixture users missing");
	owner = loadedOwner;
	member = loadedMember;
	state.user = member;
	state.passwords = [];
	state.beforeView = undefined;
	state.videoReads = 0;
	state.head.mockReset().mockImplementation(() => Effect.succeed({}));
	state.sign
		.mockReset()
		.mockImplementation((key: string) =>
			Effect.succeed(`https://synthetic.media.test/${key}`),
		);
});

it("keeps originals private from a shared member before storage access", async () => {
	await expect(getVideoDownloadInfo(videoId, "original")).rejects.toThrow(
		/permission/,
	);
	expect(state.head).not.toHaveBeenCalled();
	expect(state.sign).not.toHaveBeenCalled();
});
it("preserves owner original download", async () => {
	state.user = owner;
	expect(await getVideoDownloadInfo(videoId, "original")).toMatchObject({
		success: true,
	});
	expect(state.head).toHaveBeenCalledWith(originalKey);
});
it("preserves a shared member's published current download", async () => {
	expect(await getVideoDownloadInfo(videoId, "current")).toMatchObject({
		success: true,
	});
	expect(state.head).toHaveBeenCalledWith(currentKey);
	expect(state.sign).toHaveBeenCalledWith(currentKey);
});
it("does not turn a viewer grant into a workspace download permission", async () => {
	const guestId = User.UserId.make(`dlguest${sequence}`);
	const email = `guest-${sequence}@download.test`;
	await runtime.database.insert(Db.users).values({
		id: guestId,
		email,
		emailVerified: new Date(),
		activeOrganizationId: owner.activeOrganizationId,
	});
	await runtime.database.insert(Db.videoViewerGrants).values({
		id: `guestgrant${sequence}`,
		videoId,
		email,
		invitedByUserId: owner.id,
	});
	const [guest] = await runtime.database
		.select()
		.from(Db.users)
		.where(eq(Db.users.id, guestId));
	if (!guest) throw Error("Guest fixture missing");
	state.user = guest;
	await expect(getVideoDownloadInfo(videoId, "current")).rejects.toThrow(
		/permission/,
	);
	expect(state.head).not.toHaveBeenCalled();
});
it("requires the actual video password before a member download", async () => {
	await runtime.database
		.update(Db.videos)
		.set({ password: "verified-hash" })
		.where(eq(Db.videos.id, videoId));
	await expect(getVideoDownloadInfo(videoId, "current")).rejects.toBeDefined();
	expect(state.head).not.toHaveBeenCalled();
	state.passwords = ["verified-hash"];
	expect(await getVideoDownloadInfo(videoId, "current")).toMatchObject({
		success: true,
	});
});
it("denies a revoked share between download eligibility and view authorization", async () => {
	state.beforeView = async () => {
		await runtime.database
			.delete(Db.organizationMembers)
			.where(eq(Db.organizationMembers.userId, member.id));
	};
	await expect(getVideoDownloadInfo(videoId, "current")).rejects.toBeDefined();
	expect(state.head).not.toHaveBeenCalled();
});
it("does not sign stale output when a new publication wins before view authorization", async () => {
	state.beforeView = async () => {
		await runtime.database
			.update(Db.videos)
			.set({
				source: {
					type: "webMP4",
					outputKey: currentKey.replace("/current/", "/new/"),
				},
			})
			.where(eq(Db.videos.id, videoId));
	};
	await expect(getVideoDownloadInfo(videoId, "current")).rejects.toThrow(
		/changed/,
	);
	expect(state.head).not.toHaveBeenCalled();
});
