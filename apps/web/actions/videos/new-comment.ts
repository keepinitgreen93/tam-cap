"use server";

import { getCurrentUser } from "@cap/database/auth/session";
import { db } from "@cap/database/cloudflare/application";
import { videos } from "@cap/database/cloudflare/schema";
import { nanoId } from "@cap/database/helpers";
import { provideOptionalAuth, VideosPolicy } from "@cap/web-backend";
import type { ImageUpload } from "@cap/web-domain";
import { Comment, Policy, type Video } from "@cap/web-domain";
import { eq } from "drizzle-orm";
import { Effect, Exit } from "effect";
import { revalidatePath } from "next/cache";
import { insertComment } from "@/lib/comment-persistence";
import { createNotification } from "@/lib/Notification";
import * as EffectRuntime from "@/lib/server";

export async function newComment(data: {
	content: string;
	videoId: Video.VideoId;
	type: "text" | "emoji";
	authorImage: ImageUpload.ImageUrl | null;
	parentCommentId: Comment.CommentId;
	timestamp: number | null;
}) {
	const user = await getCurrentUser();

	if (!user) {
		throw new Error("User not authenticated");
	}

	const content = data.content;
	const videoId = data.videoId;
	const type = data.type;
	const parentCommentId = data.parentCommentId;
	const timestamp = data.timestamp;
	const conditionalType = parentCommentId
		? "reply"
		: type === "emoji"
			? "reaction"
			: "comment";

	if (!content || !videoId) {
		throw new Error("Content and videoId are required");
	}

	const accessExit = await Effect.gen(function* () {
		const videosPolicy = yield* VideosPolicy;
		return yield* Effect.promise(() =>
			db()
				.select({ id: videos.id })
				.from(videos)
				.where(eq(videos.id, videoId))
				.limit(1),
		).pipe(Policy.withPublicPolicy(videosPolicy.canView(videoId)));
	}).pipe(provideOptionalAuth, EffectRuntime.runPromiseExit);

	if (Exit.isFailure(accessExit)) {
		console.error("Video access check failed:", accessExit);
		throw new Error("Video not found");
	}

	if (accessExit.value.length === 0) {
		throw new Error("Video not found");
	}

	const id = Comment.CommentId.make(nanoId());

	const newComment = {
		id: id,
		authorId: user.id,
		type: type,
		content: content,
		videoId: videoId,
		timestamp: timestamp ?? null,
		parentCommentId: parentCommentId,
		mediaKey: null,
		mediaDuration: null,
		mediaMeta: null,
		createdAt: new Date(),
		updatedAt: new Date(),
	};

	const inserted = await insertComment(db(), newComment, {
		authorize: (policy) =>
			Effect.void.pipe(
				Policy.withPublicPolicy(policy),
				provideOptionalAuth,
				EffectRuntime.runPromise,
			),
	});

	try {
		if (inserted.created)
			await createNotification({
				type: conditionalType,
				videoId,
				authorId: user.id,
				comment: { id, content },
				parentCommentId,
			});
	} catch (error) {
		console.error("Failed to create notification:", error);
	}

	// Add author name to the returned data
	const commentWithAuthor = {
		...newComment,
		authorName: user.name,
		authorImage: data.authorImage,
		sending: false,
	};

	revalidatePath(`/s/${videoId}`);

	return commentWithAuthor;
}
