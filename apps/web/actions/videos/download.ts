"use server";

import { getCurrentUser } from "@cap/database/auth/session";
import { db } from "@cap/database/cloudflare/application";
import {
	videoEdits,
	videos,
	videoUploads,
} from "@cap/database/cloudflare/schema";
import { Storage } from "@cap/web-backend";
import { VideosPolicy } from "@cap/web-backend/src/Videos/VideosPolicy";
import { CurrentUser, Video } from "@cap/web-domain";
import { eq } from "drizzle-orm";
import { Effect, Option } from "effect";
import { runPromise } from "@/lib/server";
import { canUserDownloadVideo } from "@/lib/video-download-permissions";
import { getVideoEditingBase } from "@/lib/video-editing-base";
import { decodeStorageVideo } from "@/lib/video-storage";

export type VideoDownloadVariant = "current" | "original";
export type VideoDownloadInfo =
	| {
			success: true;
			downloadUrl: string;
			filename: string;
	  }
	| {
			success: false;
			error: string;
	  };

export async function downloadVideo(videoId: Video.VideoId) {
	const user = await getCurrentUser();

	if (!user || !videoId) {
		throw new Error("Missing required data for downloading video");
	}

	const userId = user.id;
	const query = await db().select().from(videos).where(eq(videos.id, videoId));

	if (query.length === 0) {
		throw new Error("Video not found");
	}

	const video = query[0];
	if (!video) {
		throw new Error("Video not found");
	}

	if (video.ownerId !== userId) {
		throw new Error("You don't have permission to download this video");
	}

	try {
		const videoKey = `${video.ownerId}/${videoId}/result.mp4`;

		const downloadUrl = await Effect.gen(function* () {
			const [bucket] = yield* Storage.getAccessForVideo(
				decodeStorageVideo(video),
			);
			return yield* bucket.getSignedObjectUrl(videoKey);
		}).pipe(runPromise);

		return {
			success: true,
			downloadUrl,
			filename: `${video.name}.mp4`,
		};
	} catch (error) {
		console.error("Error generating download URL:", error);
		if (error instanceof Error) {
			throw new Error(error.message);
		}
		throw new Error("Failed to generate download URL");
	}
}

export async function getVideoDownloadInfo(
	videoId: Video.VideoId,
	variant: VideoDownloadVariant = "current",
): Promise<VideoDownloadInfo> {
	if (variant !== "current" && variant !== "original") {
		throw new Error("Invalid video download variant");
	}
	const user = await getCurrentUser();
	if (!user || !videoId) {
		throw new Error("Missing required data for downloading video");
	}

	const [video] = await db()
		.select()
		.from(videos)
		.where(eq(videos.id, videoId));

	if (!video) throw new Error("Video not found");
	if (variant === "original" && user.id !== video.ownerId) {
		throw new Error("You don't have permission to download the original video");
	}

	const allowed = await canUserDownloadVideo({
		userId: user.id,
		ownerId: video.ownerId,
		videoId,
	});

	if (!allowed) {
		throw new Error("You don't have permission to download this video");
	}
	if (user.id !== video.ownerId) {
		const viewable = await Effect.gen(function* () {
			const policy = yield* VideosPolicy;
			return yield* policy.getViewableById(videoId);
		}).pipe(
			Effect.provideService(CurrentUser, {
				id: user.id,
				email: user.email,
				activeOrganizationId: user.activeOrganizationId,
				iconUrlOrKey: Option.fromNullable(user.image),
			}),
			runPromise,
		);
		if (Option.isNone(viewable)) throw new Error("Video not found");
		const current = viewable.value[0];
		if (
			current.ownerId !== video.ownerId ||
			current.orgId !== video.orgId ||
			Option.getOrNull(current.bucketId) !== video.bucket ||
			Option.getOrNull(current.storageIntegrationId) !==
				video.storageIntegrationId ||
			JSON.stringify(Object.entries(current.source).sort()) !==
				JSON.stringify(Object.entries(video.source).sort())
		)
			throw new Error("Video changed. Reload before downloading.");
	}

	if (variant === "current") {
		const [activeUpload] = await db()
			.select({ phase: videoUploads.phase })
			.from(videoUploads)
			.where(eq(videoUploads.videoId, videoId));

		if (video.source?.type === "desktopSegments") {
			return {
				success: false,
				error: "Video is still processing. Try again once it has finished.",
			};
		}

		if (activeUpload && activeUpload.phase !== "complete") {
			return {
				success: false,
				error:
					activeUpload.phase === "error"
						? "Video processing failed before the MP4 was ready."
						: "Video is still processing. Try again once it has finished.",
			};
		}
	}

	let downloadKey = `${video.ownerId}/${videoId}/result.mp4`;
	let filename = `${video.name}.mp4`;

	if (variant === "original") {
		const base = getVideoEditingBase(video);
		const [existingEdit] = await db()
			.select({ sourceKey: videoEdits.sourceKey })
			.from(videoEdits)
			.where(eq(videoEdits.videoId, videoId));

		if (!existingEdit && !base) {
			return {
				success: false,
				error: "Original video is no longer available.",
			};
		}

		downloadKey = base?.sourceKey ?? existingEdit?.sourceKey ?? downloadKey;
		filename = `${video.name} (original).mp4`;
	}

	try {
		const decodedVideo = decodeStorageVideo(video);
		if (variant === "current") {
			const source = Video.Video.getSource(decodedVideo);
			if (source instanceof Video.Mp4Source) {
				downloadKey = source.getFileKey();
			}
		}
		const downloadUrl = await Effect.gen(function* () {
			const [bucket] = yield* Storage.getAccessForVideo(decodedVideo);
			const exists = yield* bucket.headObject(downloadKey).pipe(
				Effect.as(true),
				Effect.catchAll(() => Effect.succeed(false)),
			);
			if (!exists) return null;
			return yield* bucket.getSignedObjectUrl(downloadKey);
		}).pipe(runPromise);

		if (!downloadUrl) {
			return {
				success: false,
				error:
					variant === "original"
						? "Original video is no longer available."
						: "Video file is not available for download yet.",
			};
		}

		return { success: true as const, downloadUrl, filename };
	} catch (error) {
		console.error("Error generating download URL:", error);
		return {
			success: false,
			error: "Failed to prepare the video download.",
		};
	}
}
