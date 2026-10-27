import { comments, type users, videos } from "@cap/database/cloudflare/schema";
import { nanoId } from "@cap/database/helpers";
import { and, eq, ne } from "drizzle-orm";
import { Effect, Option } from "effect";
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

const state = vi.hoisted(() => ({
	database: undefined as
		| Awaited<ReturnType<typeof createTestDatabase>>["database"]
		| undefined,
	user: undefined as typeof users.$inferSelect | undefined,
	video: undefined as typeof videos.$inferSelect | undefined,
	commentId: "",
	parentId: "",
	notify: vi.fn(),
}));
vi.mock("server-only", () => ({}));
vi.mock("@cap/database/cloudflare/application", () => ({
	db: () => state.database,
}));
vi.mock("@cap/database/auth/session", () => ({
	getCurrentUser: async () => state.user,
}));
vi.mock("@cap/env", () => ({
	buildEnv: { NEXT_PUBLIC_IS_CAP: "false" },
	serverEnv: () => ({}),
}));
vi.mock("@cap/web-backend", async () => {
	const { decodeStorageVideo } = await import("@/lib/video-storage");
	return {
		provideOptionalAuth: (effect: unknown) => effect,
		verifyCommentMediaUploadToken: () => ({
			userId: state.user?.id,
			videoId: state.video?.id,
			commentId: state.commentId,
			kind: "audio",
			key: `${state.video?.ownerId}/${state.video?.id}/comments/${state.commentId}/media.webm`,
			thumbnailKey: null,
			contentType: "audio/webm",
		}),
		VideosRepo: Effect.succeed({
			getById: () => {
				if (!state.video) throw new Error("Video missing");
				return Effect.succeed(Option.some([decodeStorageVideo(state.video)]));
			},
		}),
		VideosPolicy: Effect.succeed({ canView: () => Effect.void }),
		Storage: {
			getAccessForVideo: () =>
				Effect.succeed([
					{ headObject: () => Effect.succeed({ ContentLength: 2048 }) },
				]),
		},
	};
});
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
vi.mock("@/lib/media-comments", () => ({
	canUseMediaComments: async () => true,
}));
vi.mock("@/lib/Notification", () => ({ createNotification: state.notify }));
vi.mock("@/lib/server", () => ({
	runPromiseExit: Effect.runPromiseExit,
	runPromise: Effect.runPromise,
}));

import { newComment } from "@/actions/videos/new-comment";
import { newMediaComment } from "@/actions/videos/new-media-comment";

let runtime: Awaited<ReturnType<typeof createTestDatabase>>;
function requiredVideo() {
	if (!state.video) throw new Error("Fixture missing");
	return state.video;
}
const postText = (parentId = state.parentId) =>
	newComment({
		content: "A reply",
		videoId: requiredVideo().id,
		type: "text",
		authorImage: null,
		parentCommentId: parentId as never,
		timestamp: null,
	});
const postMedia = (parentId = state.parentId) =>
	newMediaComment({
		videoId: requiredVideo().id,
		commentId: state.commentId as never,
		uploadToken: "synthetic-token",
		kind: "audio",
		durationSeconds: 3,
		parentCommentId: parentId as never,
		timestamp: null,
		authorImage: null,
	});
async function inserted() {
	return runtime.database
		.select()
		.from(comments)
		.where(
			and(
				eq(comments.videoId, requiredVideo().id),
				ne(comments.id, state.parentId as never),
			),
		);
}
beforeAll(async () => {
	runtime = await createTestDatabase();
	state.database = runtime.database;
}, 120_000);
afterAll(async () => runtime.dispose());
beforeEach(async () => {
	state.user = await createTestOwner(runtime.database);
	state.commentId = nanoId();
	state.parentId = nanoId();
	state.notify.mockReset().mockResolvedValue(undefined);
	const [row] = await runtime.database
		.insert(videos)
		.values({
			id: nanoId() as typeof videos.$inferSelect.id,
			ownerId: state.user.id,
			orgId: state.user.activeOrganizationId,
			name: "Public comment fixture",
			public: true,
			source: { type: "webMP4" },
		})
		.returning();
	if (!row) throw new Error("Fixture missing");
	state.video = row;
	await runtime.database
		.insert(comments)
		.values({
			id: state.parentId as never,
			authorId: state.user.id,
			videoId: row.id,
			type: "text",
			content: "Parent",
		});
});
describe.each([
	{ action: "newComment", post: postText },
	{ action: "newMediaComment", post: postMedia },
])("$action parent authorization on D1", ({ post }) => {
	it.each(["foreign", "missing"])(
		"rejects a %s parent without insert or notification",
		async (kind) => {
			if (kind === "missing")
				await runtime.database
					.delete(comments)
					.where(eq(comments.id, state.parentId as never));
			else {
				const video = requiredVideo();
				const id = nanoId() as typeof videos.$inferSelect.id;
				await runtime.database
					.insert(videos)
					.values({
						id,
						ownerId: video.ownerId,
						orgId: video.orgId,
						name: "Private parent fixture",
						public: false,
						source: { type: "webMP4" },
					});
				await runtime.database
					.update(comments)
					.set({ videoId: id })
					.where(eq(comments.id, state.parentId as never));
			}
			await expect(post()).rejects.toThrow("Comment not found");
			expect(await inserted()).toEqual([]);
			expect(state.notify).not.toHaveBeenCalled();
		},
	);
	it.each(["text", "emoji", "video", "audio"] as const)(
		"preserves replies to %s parents on the same video",
		async (type) => {
			await runtime.database
				.update(comments)
				.set({ type })
				.where(eq(comments.id, state.parentId as never));
			expect(await post()).toMatchObject({
				parentCommentId: state.parentId,
				videoId: requiredVideo().id,
			});
			expect(await inserted()).toHaveLength(1);
			expect(state.notify).toHaveBeenCalledWith(
				expect.objectContaining({
					type: "reply",
					parentCommentId: state.parentId,
					videoId: requiredVideo().id,
				}),
			);
		},
	);
	it("preserves top-level comments", async () => {
		expect(await post("")).toMatchObject({ parentCommentId: "" });
		expect(await inserted()).toHaveLength(1);
		expect(state.notify).toHaveBeenCalledWith(
			expect.objectContaining({ type: "comment" }),
		);
	});
});
