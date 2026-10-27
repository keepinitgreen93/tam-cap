import { isDeepStrictEqual } from "node:util";
import type { CloudflareDatabase } from "@cap/database/cloudflare";
import { atomic } from "@cap/database/cloudflare/atomic";
import { comments, users } from "@cap/database/cloudflare/schema";
import { userIsPro } from "@cap/utils";
import { requireWritableVideo } from "@cap/web-backend/src/Videos/persistence";
import { snapshotVideoViewPolicy } from "@cap/web-backend/src/Videos/snapshot-view-policy";
import type { Video } from "@cap/web-domain";
import { and, eq } from "drizzle-orm";
import { Option } from "effect";

type CommentInsert = typeof comments.$inferInsert;
export function insertComment(
	database: CloudflareDatabase,
	value: CommentInsert,
	options: {
		authorize: (
			policy: ReturnType<typeof snapshotVideoViewPolicy>,
		) => Promise<void>;
		mediaVideo?: Pick<
			Video.Video,
			"ownerId" | "bucketId" | "storageIntegrationId"
		>;
	},
) {
	return atomic<{ created: boolean }>(database, async (snapshot) => {
		const video = await requireWritableVideo(snapshot, value.videoId);
		await options.authorize(snapshotVideoViewPolicy(snapshot, video));
		const expected = options.mediaVideo;
		if (expected) {
			if (
				video.ownerId !== expected.ownerId ||
				video.bucket !== Option.getOrNull(expected.bucketId) ||
				video.storageIntegrationId !==
					Option.getOrNull(expected.storageIntegrationId)
			)
				throw new Error("Recording storage changed during comment upload");
			const [owner] = await snapshot.read((reader) =>
				reader.select().from(users).where(eq(users.id, video.ownerId)).limit(1),
			);
			if (!userIsPro(owner ?? null))
				throw new Error("Media comments are not available on this video");
		}
		if (value.parentCommentId) {
			const parentCommentId = value.parentCommentId;
			const [parent] = await snapshot.read((reader) =>
				reader
					.select({ id: comments.id })
					.from(comments)
					.where(
						and(
							eq(comments.id, parentCommentId),
							eq(comments.videoId, value.videoId),
						),
					)
					.limit(1),
			);
			if (!parent) throw new Error("Comment not found");
		}
		const [existing] = await snapshot.read((reader) =>
			reader.select().from(comments).where(eq(comments.id, value.id)).limit(1),
		);
		if (existing) {
			const fields = [
				"authorId",
				"videoId",
				"type",
				"content",
				"timestamp",
				"mediaKey",
				"mediaDuration",
				"mediaMeta",
			] as const;
			if (
				!fields.every((key) =>
					isDeepStrictEqual(
						JSON.parse(JSON.stringify(existing[key] ?? null)),
						JSON.parse(JSON.stringify(value[key] ?? null)),
					),
				) ||
				(existing.parentCommentId || null) !== (value.parentCommentId || null)
			)
				throw new Error("Comment upload was already used");
			return { statements: [], result: { created: false } };
		}
		return {
			statements: [
				database
					.insert(comments)
					.values({ ...value, parentCommentId: value.parentCommentId || null }),
			],
			result: { created: true },
		};
	});
}
