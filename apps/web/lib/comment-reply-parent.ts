import { db } from "@cap/database/cloudflare/application";
import { comments } from "@cap/database/cloudflare/schema";
import type { Comment, Video } from "@cap/web-domain";
import { and, eq } from "drizzle-orm";

export async function isReplyParentOnVideo(
	parentCommentId: Comment.CommentId,
	videoId: Video.VideoId,
) {
	const [parent] = await db()
		.select({ id: comments.id })
		.from(comments)
		.where(and(eq(comments.id, parentCommentId), eq(comments.videoId, videoId)))
		.limit(1);
	return parent !== undefined;
}
