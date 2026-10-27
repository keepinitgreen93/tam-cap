"use server";

import { db } from "@cap/database/cloudflare/application";
import { videos, videoUploads } from "@cap/database/cloudflare/schema";
import { Storage } from "@cap/web-backend";
import { writableVideo } from "@cap/web-backend/src/Videos/persistence";
import { Video } from "@cap/web-domain";
import { and, eq } from "drizzle-orm";
import { Option } from "effect";
import { requireAdmin } from "@/lib/admin-access";
import {
	invalidateReuploadedVideo,
	publishDesktopReupload,
} from "@/lib/desktop-reupload";
import {
	assertDesktopReuploadTarget,
	createDesktopReuploadKey,
	createDesktopReuploadToken,
	decodeDesktopReuploadToken,
} from "@/lib/desktop-reupload-token";
import { queueVideoTranscription } from "@/lib/queue-video-transcription";
import { ownedRecordingPlan } from "@/lib/recording-upload-state";
import { runPromise } from "@/lib/server";
import { decodeStorageVideo } from "@/lib/video-storage";

async function getVideoOrThrow(videoId: string) {
	const [video] = await db()
		.select()
		.from(videos)
		.where(and(writableVideo, eq(videos.id, Video.VideoId.make(videoId))));
	if (!video) throw new Error("Video not found");
	return decodeStorageVideo(video);
}

export async function getVideoReplaceUploadUrl(videoId: string) {
	await requireAdmin();
	const video = await getVideoOrThrow(videoId);
	const [bucket] = await Storage.getAccessForVideo(video, {
		resolvePublishedOutput: false,
	}).pipe(runPromise);
	const outputKey = createDesktopReuploadKey(video);
	const replacementToken = createDesktopReuploadToken(video, {
		provider: bucket.provider,
		uploadId: "singlepart",
		outputKey,
	});
	const token = decodeDesktopReuploadToken(replacementToken);
	if (!token) throw new Error("Replacement token was not created");
	const database = db();
	const now = new Date();
	const previous = await ownedRecordingPlan(
		database,
		video,
		async (snapshot, current) => {
			assertDesktopReuploadTarget(
				token,
				{ ...video, source: current.source },
				`${video.ownerId}/${video.id}/result.mp4`,
			);
			if (current.metadata?.editProcessing)
				throw new Error("A video edit is already processing");
			const [upload] = await snapshot.read((reader) =>
				reader
					.select()
					.from(videoUploads)
					.where(eq(videoUploads.videoId, video.id)),
			);
			if (upload && upload.phase !== "error" && upload.phase !== "complete")
				throw new Error("A recording upload is already in progress");
			const values = {
				videoId: video.id,
				uploaded: 0,
				total: 0,
				startedAt: now,
				updatedAt: now,
				mode: "singlepart" as const,
				phase: "uploading" as const,
				processingProgress: 0,
				processingMessage: null,
				processingError: null,
				rawFileKey: outputKey,
			};
			return {
				statements: [
					database
						.insert(videoUploads)
						.values(values)
						.onConflictDoUpdate({ target: videoUploads.videoId, set: values }),
				],
				result: upload,
			};
		},
	);
	try {
		const uploadTarget = await bucket
			.createUploadTarget(outputKey, {
				contentType: "video/mp4",
				method: "put",
				ifNoneMatch: "*",
			})
			.pipe(runPromise);
		return { uploadTarget, replacementToken };
	} catch (error) {
		await ownedRecordingPlan(database, video, async (snapshot) => {
			const [upload] = await snapshot.read((reader) =>
				reader
					.select()
					.from(videoUploads)
					.where(eq(videoUploads.videoId, video.id)),
			);
			if (upload?.rawFileKey !== outputKey)
				return { statements: [], result: undefined };
			return {
				statements: [
					previous
						? database
								.update(videoUploads)
								.set(previous)
								.where(eq(videoUploads.videoId, video.id))
						: database
								.delete(videoUploads)
								.where(eq(videoUploads.videoId, video.id)),
				],
				result: undefined,
			};
		}).catch(() => undefined);
		throw error;
	}
}

export async function invalidateVideoCache(
	videoId: string,
	replacementToken: string,
) {
	await requireAdmin();
	const token = decodeDesktopReuploadToken(replacementToken);
	if (!token || token.uploadId !== "singlepart")
		throw new Error("Invalid replacement token");
	const video = await getVideoOrThrow(videoId);
	const [bucket] = await Storage.getAccessForVideo(video, {
		resolvePublishedOutput: false,
	}).pipe(runPromise);
	assertDesktopReuploadTarget(
		token,
		video,
		`${video.ownerId}/${video.id}/result.mp4`,
		bucket.provider,
	);
	const head = await bucket.headObject(token.outputKey).pipe(runPromise);
	if (!head.ETag || !head.ContentLength || head.ContentLength <= 0)
		throw new Error("Replacement recording has not finished uploading");
	const published = await publishDesktopReupload(db(), video, token);
	if (!published && Option.isSome(video.transcriptionStatus)) return;
	await Promise.allSettled([
		queueVideoTranscription(video.id),
		invalidateReuploadedVideo(video),
	]);
}
