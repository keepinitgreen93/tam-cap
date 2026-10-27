"use server";

import { getCurrentUser } from "@cap/database/auth/session";
import { db } from "@cap/database/cloudflare/application";
import { type AtomicStatement, atomic } from "@cap/database/cloudflare/atomic";
import { comments, notifications } from "@cap/database/cloudflare/schema";
import { Storage, VideosRepo } from "@cap/web-backend";
import { requireLiveVideo } from "@cap/web-backend/src/Videos/persistence";
import type { Comment, Video } from "@cap/web-domain";
import { and, eq, sql } from "drizzle-orm";
import { Effect, Option } from "effect";
import { revalidatePath } from "next/cache";
import * as EffectRuntime from "@/lib/server";

export async function deleteComment({
	commentId,
	parentId: _parentId,
	videoId,
}: {
	commentId: Comment.CommentId;
	parentId: Comment.CommentId | null;
	videoId: Video.VideoId;
}) {
	const user = await getCurrentUser();

	if (!user) {
		throw new Error("User not authenticated");
	}

	if (!commentId || !videoId) {
		throw new Error("Comment ID and video ID are required");
	}

	try {
		const database = db();
		const deletedMedia = await atomic(database, async (snapshot) => {
			const statements: AtomicStatement[] = [];
			let media: {
				videoId: Video.VideoId;
				mediaKey: string;
				thumbnailKey: string | null;
			} | null = null;

			// First, verify the comment exists and belongs to the current user
			const [existingComment] = await snapshot.read((reader) =>
				reader
					.select({
						id: comments.id,
						parentCommentId: comments.parentCommentId,
						videoId: comments.videoId,
						mediaKey: comments.mediaKey,
						mediaMeta: comments.mediaMeta,
					})
					.from(comments)
					.where(
						and(eq(comments.id, commentId), eq(comments.authorId, user.id)),
					)
					.limit(1),
			);

			if (!existingComment) {
				throw new Error(
					"Comment not found or you don't have permission to delete it",
				);
			}

			await requireLiveVideo(snapshot, existingComment.videoId);
			if (existingComment.mediaKey) {
				media = {
					// The comment's own videoId, not the client-supplied one, decides
					// which bucket the objects are deleted from.
					videoId: existingComment.videoId,
					mediaKey: existingComment.mediaKey,
					thumbnailKey: existingComment.mediaMeta?.thumbnailKey ?? null,
				};
			}

			statements.push(
				database
					.delete(comments)
					.where(
						and(eq(comments.id, commentId), eq(comments.authorId, user.id)),
					),
			);

			// Delete related notifications
			if (existingComment.parentCommentId) {
				statements.push(
					database
						.delete(notifications)
						.where(
							and(
								eq(notifications.type, "reply"),
								sql`JSON_EXTRACT(${notifications.data}, '$.comment.id') = ${commentId}`,
							),
						),
				);
			} else {
				statements.push(
					database
						.delete(notifications)
						.where(
							and(
								eq(notifications.type, "comment"),
								sql`JSON_EXTRACT(${notifications.data}, '$.comment.id') = ${commentId}`,
							),
						),
				);

				statements.push(
					database
						.delete(notifications)
						.where(
							and(
								eq(notifications.type, "reply"),
								sql`JSON_EXTRACT(${notifications.data}, '$.comment.parentCommentId') = ${commentId}`,
							),
						),
				);
			}
			return { statements, result: media };
		});

		// After the row is gone, best-effort delete of the media objects; a
		// storage failure must not fail the action (the video-delete prefix sweep
		// reclaims any stragglers).
		if (deletedMedia) {
			const { videoId: mediaVideoId, mediaKey, thumbnailKey } = deletedMedia;
			await Effect.gen(function* () {
				const repo = yield* VideosRepo;
				const maybeVideo = yield* repo.getById(mediaVideoId);
				if (Option.isNone(maybeVideo)) return;
				const [bucket] = yield* Storage.getAccessForVideo(maybeVideo.value[0]);
				yield* bucket.deleteObjects([
					{ Key: mediaKey },
					...(thumbnailKey ? [{ Key: thumbnailKey }] : []),
				]);
			}).pipe(
				// catchAllCause, not catchAll: a defect (missing credential, storage
				// layer panic) must not fail the action either — the row is gone.
				Effect.catchAllCause((cause) =>
					Effect.logError("Failed to delete comment media objects", cause),
				),
				EffectRuntime.runPromise,
			);
		}

		revalidatePath(`/s/${videoId}`);
		return { success: true };
	} catch (error) {
		console.error("Error deleting comment:", error);
		throw error;
	}
}
