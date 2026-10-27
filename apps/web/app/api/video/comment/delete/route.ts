import { isCrossSiteCookieWrite } from "@cap/database/auth/request-site";
import { getCurrentUser } from "@cap/database/auth/session";
import { db } from "@cap/database/cloudflare/application";
import { atomic } from "@cap/database/cloudflare/atomic";
import { comments, videos } from "@cap/database/cloudflare/schema";
import { activeVideo } from "@cap/web-backend/src/Videos/persistence";
import { Comment } from "@cap/web-domain";
import { and, eq, or, sql } from "drizzle-orm";
import { Option } from "effect";
import type { NextRequest } from "next/server";
import { getHeaders } from "@/utils/helpers";

export async function DELETE(request: NextRequest) {
	const user = isCrossSiteCookieWrite(request) ? null : await getCurrentUser();
	const { searchParams } = request.nextUrl;
	const commentId = Option.fromNullable(searchParams.get("commentId")).pipe(
		Option.map(Comment.CommentId.make),
	);
	const origin = request.headers.get("origin");

	if (!Option.isSome(commentId) || !user?.id) {
		return new Response(JSON.stringify({ error: "Missing required data" }), {
			status: 400,
			headers: getHeaders(origin),
		});
	}

	try {
		const database = db();
		const id = commentId.value;
		const deleted = await atomic(database, async (snapshot) => {
			const [comment] = await snapshot.read((reader) =>
				reader
					.select()
					.from(comments)
					.where(
						and(
							eq(comments.id, id),
							eq(comments.authorId, user.id),
							sql`exists (select 1 from ${videos} where ${videos.id} = ${comments.videoId} and ${activeVideo})`,
						),
					)
					.limit(1),
			);
			if (!comment) return { statements: [], result: false };
			return {
				statements: [
					database
						.delete(comments)
						.where(
							and(
								eq(comments.authorId, user.id),
								eq(comments.videoId, comment.videoId),
								or(eq(comments.id, id), eq(comments.parentCommentId, id)),
							),
						),
				],
				result: true,
			};
		});
		if (!deleted)
			return new Response(
				JSON.stringify({ error: "Comment not found or unauthorized" }),
				{ status: 404, headers: getHeaders(origin) },
			);

		return new Response(JSON.stringify({ success: true }), {
			status: 200,
			headers: getHeaders(origin),
		});
	} catch (error) {
		console.error("Error deleting comment:", error);
		return new Response(JSON.stringify({ error: "Failed to delete comment" }), {
			status: 500,
			headers: getHeaders(origin),
		});
	}
}
