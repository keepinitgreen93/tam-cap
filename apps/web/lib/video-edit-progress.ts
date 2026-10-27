import { db } from "@cap/database/cloudflare/application";
import { type AtomicStatement, atomic } from "@cap/database/cloudflare/atomic";
import { videos, videoUploads } from "@cap/database/cloudflare/schema";
import { writableVideo } from "@cap/web-backend/src/Videos/persistence";
import type { Video } from "@cap/web-domain";
import { and, eq } from "drizzle-orm";
import {
	getEditProcessingState,
	matchesEditOperation,
} from "./video-edit-operation";

interface EditProgress {
	videoId: string;
	jobId: string;
	phase: string;
	progress: number;
	message?: string;
	error?: string;
	metadata?: { duration: number; width: number; height: number; fps: number };
}

export async function applyEditProgress(
	payload: EditProgress,
	token: string | null,
	startedAt: string | null,
) {
	const database = db();
	const mutationTime = new Date();
	return atomic(database, async (snapshot) => {
		const statements: AtomicStatement[] = [];
		const [video] = await snapshot.read((reader) =>
			reader
				.select()
				.from(videos)
				.where(
					and(writableVideo, eq(videos.id, payload.videoId as Video.VideoId)),
				),
		);
		const state = getEditProcessingState(video?.metadata ?? null);
		if (!token && !state) {
			if (
				video &&
				"outputKey" in video.source &&
				video.source.outputKey?.startsWith(
					`${video.ownerId}/${video.id}/.recording/outputs/edit-`,
				)
			) {
				const [currentUpload] = await snapshot.read((reader) =>
					reader
						.select()
						.from(videoUploads)
						.where(eq(videoUploads.videoId, video.id)),
				);
				if (
					!currentUpload ||
					currentUpload.rawFileKey ===
						`${video.ownerId}/${video.id}/source/original.mp4`
				)
					return { statements, result: true };
			}
			return { statements, result: false };
		}
		if (!video || !state || !token || !startedAt)
			return { statements, result: true };
		const [upload] = await snapshot.read((reader) =>
			reader
				.select()
				.from(videoUploads)
				.where(eq(videoUploads.videoId, video.id)),
		);
		if (
			!upload ||
			!matchesEditOperation(video, upload, state.sourceKey, {
				token,
				startedAt,
			}) ||
			state.dispatch === "pending" ||
			(state.jobId && state.jobId !== payload.jobId)
		)
			return { statements, result: true };
		if (upload.phase === "complete" || upload.phase === "error")
			return { statements, result: true };
		const complete = payload.phase === "complete";
		const failed = payload.phase === "error" || payload.phase === "cancelled";
		if (
			complete &&
			(!payload.metadata ||
				![
					payload.metadata.duration,
					payload.metadata.width,
					payload.metadata.height,
					payload.metadata.fps,
				].every((value) => Number.isFinite(value) && value > 0))
		) {
			throw new Error("Edit completion is missing valid media metadata");
		}
		statements.push(
			database
				.update(videos)
				.set({
					metadata: {
						...video.metadata,
						editProcessing: {
							...state,
							dispatch: "accepted",
							jobId: payload.jobId,
							...(complete && payload.metadata
								? {
										renderedMetadata: {
											duration: payload.metadata.duration,
											width: payload.metadata.width,
											height: payload.metadata.height,
											fps: payload.metadata.fps,
										},
									}
								: {}),
						},
					},
				})
				.where(eq(videos.id, video.id)),
		);

		statements.push(
			database
				.update(videoUploads)
				.set({
					phase: complete ? "complete" : failed ? "error" : "processing",
					processingProgress: complete
						? 100
						: Number.isFinite(payload.progress)
							? Math.round(Math.max(0, Math.min(100, payload.progress)))
							: 0,
					processingMessage: payload.message,
					processingError: failed
						? payload.error || payload.message || "Video edit failed"
						: null,
					updatedAt: mutationTime,
				})
				.where(eq(videoUploads.videoId, video.id)),
		);
		return { statements, result: true };
	});
}
