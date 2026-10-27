import { createCloudflareDb } from "@cap/database/cloudflare";
import {
	createD1BridgeBinding,
	handleD1BridgeRequest,
} from "@cap/database/cloudflare/bridge";
import * as Db from "@cap/database/cloudflare/schema";
import { Comment, Organisation, User, Video } from "@cap/web-domain";
import { eq } from "drizzle-orm";
import { NextRequest } from "next/server";
import { afterAll, beforeAll, expect, it, vi } from "vitest";
import { createTestDatabase } from "../../../../packages/database/cloudflare/test-runtime";

const state = vi.hoisted(() => ({
	database: undefined as ReturnType<typeof createCloudflareDb> | undefined,
	user: undefined as { id: User.UserId } | undefined,
}));
vi.mock("@cap/env", () => ({
	buildEnv: { NEXT_PUBLIC_WEB_URL: "https://cap.test" },
	serverEnv: () => ({ WEB_URL: "https://cap.test" }),
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

import { DELETE } from "@/app/api/video/comment/delete/route";

let runtime: Awaited<ReturnType<typeof createTestDatabase>>;
let beforeBatch: (() => Promise<void>) | undefined;
let sequence = 0;
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
async function fixture() {
	const s = String(++sequence);
	const userId = User.UserId.make(`deluser${s}`),
		otherId = User.UserId.make(`delother${s}`),
		orgId = Organisation.OrganisationId.make(`delorg${s}`),
		videoId = Video.VideoId.make(`delvideo${s}`),
		otherVideoId = Video.VideoId.make(`delvid2${s}`),
		commentId = Comment.CommentId.make(`delcomment${s}`);
	await runtime.database.insert(Db.users).values([
		{ id: userId, email: `${s}user@delete.test`, activeOrganizationId: orgId },
		{
			id: otherId,
			email: `${s}other@delete.test`,
			activeOrganizationId: orgId,
		},
	]);
	await runtime.database
		.insert(Db.organizations)
		.values({ id: orgId, ownerId: userId, name: "Delete" });
	await runtime.database.insert(Db.videos).values([
		{ id: videoId, orgId, ownerId: userId, source: { type: "webMP4" } },
		{ id: otherVideoId, orgId, ownerId: userId, source: { type: "webMP4" } },
	]);
	await runtime.database.insert(Db.comments).values({
		id: commentId,
		videoId,
		authorId: userId,
		type: "text",
		content: "Parent",
	});
	state.user = { id: userId };
	return { userId, otherId, orgId, videoId, otherVideoId, commentId };
}
function remove(id: string) {
	return DELETE(
		new NextRequest(
			`https://cap.test/api/video/comment/delete?commentId=${id}`,
			{ method: "DELETE" },
		),
	);
}
it("deletes only the author's parent and same-video replies", async () => {
	const f = await fixture();
	const ownReply = Comment.CommentId.make("ownreply"),
		foreignReply = Comment.CommentId.make("foreignreply"),
		otherVideoReply = Comment.CommentId.make("othervidreply");
	await runtime.database.insert(Db.comments).values([
		{
			id: ownReply,
			authorId: f.userId,
			videoId: f.videoId,
			parentCommentId: f.commentId,
			type: "text",
			content: "Own",
		},
		{
			id: foreignReply,
			authorId: f.otherId,
			videoId: f.videoId,
			parentCommentId: f.commentId,
			type: "text",
			content: "Other writer",
		},
		{
			id: otherVideoReply,
			authorId: f.userId,
			videoId: f.otherVideoId,
			parentCommentId: f.commentId,
			type: "text",
			content: "Other video",
		},
	]);
	expect((await remove(f.commentId)).status).toBe(200);
	const remaining = await runtime.database
		.select({ id: Db.comments.id })
		.from(Db.comments);
	expect(remaining.map((row) => row.id)).toEqual(
		expect.arrayContaining([foreignReply, otherVideoReply]),
	);
	expect(remaining.map((row) => row.id)).not.toEqual(
		expect.arrayContaining([f.commentId]),
	);
	expect(remaining.map((row) => row.id)).not.toEqual(
		expect.arrayContaining([ownReply]),
	);
});
it.each(["author", "organization"] as const)(
	"rechecks a concurrent %s change before deletion",
	async (change) => {
		const f = await fixture();
		beforeBatch = async () => {
			if (change === "author")
				await runtime.database
					.update(Db.comments)
					.set({ authorId: f.otherId })
					.where(eq(Db.comments.id, f.commentId));
			else
				await runtime.database
					.update(Db.organizations)
					.set({ tombstoneAt: new Date() })
					.where(eq(Db.organizations.id, f.orgId));
		};
		expect((await remove(f.commentId)).status).toBe(404);
		expect(
			await runtime.database
				.select()
				.from(Db.comments)
				.where(eq(Db.comments.id, f.commentId)),
		).toHaveLength(1);
	},
);
it("does not delete another author's comment", async () => {
	const f = await fixture();
	state.user = { id: f.otherId };
	expect((await remove(f.commentId)).status).toBe(404);
	expect(
		await runtime.database
			.select()
			.from(Db.comments)
			.where(eq(Db.comments.id, f.commentId)),
	).toHaveLength(1);
});
