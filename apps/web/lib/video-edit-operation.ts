import { isDeepStrictEqual } from "node:util";
import type { CloudflareDatabase } from "@cap/database/cloudflare";
import { db } from "@cap/database/cloudflare/application";
import {
	type AtomicPlan,
	type AtomicSnapshot,
	type AtomicStatement,
	atomic,
} from "@cap/database/cloudflare/atomic";
import {
	videoProcessingJobs,
	videos,
	videoUploads,
} from "@cap/database/cloudflare/schema";
import type { VideoMetadata } from "@cap/database/types";
import {
	requireOwnedVideo,
	writableVideo,
} from "@cap/web-backend/src/Videos/persistence";
import type { Video } from "@cap/web-domain";
import { and, eq } from "drizzle-orm";
import { FatalError } from "workflow";
import { z } from "zod";
import { getVideoEditingBase } from "./video-editing-base";

export interface EditOperation {
	token: string;
	startedAt: string;
}

const stateSchema = z.object({
	token: z.string().uuid(),
	editingBaseId: z.string().uuid().nullable().optional(),
	startedAt: z.string().datetime(),
	ownerId: z.string(),
	bucket: z.string().nullable(),
	storageIntegrationId: z.string().nullable(),
	sourceKey: z.string(),
	source: z.string(),
	dispatch: z.enum(["pending", "dispatching", "accepted"]),
	jobId: z.string().optional(),
	resultCommitted: z.boolean().optional(),
	renderedMetadata: z
		.object({
			duration: z.number().positive(),
			width: z.number().positive(),
			height: z.number().positive(),
			fps: z.number().positive(),
		})
		.optional(),
});
export type EditProcessingState = z.infer<typeof stateSchema>;

export function getEditProcessingState(metadata: VideoMetadata | null) {
	if (
		!metadata ||
		typeof metadata !== "object" ||
		!("editProcessing" in metadata)
	)
		return undefined;
	const parsed = stateSchema.safeParse(metadata.editProcessing);
	return parsed.success ? parsed.data : undefined;
}

export function withoutEditProcessing(metadata: VideoMetadata | null) {
	const next = { ...metadata };
	delete next.editProcessing;
	return next;
}

export function matchesEditOperation(
	video: Pick<
		typeof videos.$inferSelect,
		"metadata" | "source" | "ownerId" | "bucket" | "storageIntegrationId"
	> & { id?: Video.VideoId },
	upload:
		| Pick<typeof videoUploads.$inferSelect, "rawFileKey" | "startedAt">
		| undefined,
	sourceKey: string,
	operation: EditOperation,
) {
	const state = getEditProcessingState(video.metadata);
	if (!state) return false;
	let expectedSource: unknown;
	try {
		expectedSource = JSON.parse(state.source);
	} catch {
		return false;
	}
	let editingBase: ReturnType<typeof getVideoEditingBase> = null;
	if (video.metadata && Object.hasOwn(video.metadata, "editingBase")) {
		if (!video.id) return false;
		try {
			editingBase = getVideoEditingBase({ ...video, id: video.id });
		} catch {
			return false;
		}
	}
	return Boolean(
		upload &&
			state.token === operation.token &&
			state.startedAt === operation.startedAt &&
			state.ownerId === video.ownerId &&
			state.bucket === video.bucket &&
			state.storageIntegrationId === video.storageIntegrationId &&
			state.sourceKey === sourceKey &&
			(editingBase
				? state.editingBaseId === editingBase.id &&
					sourceKey === editingBase.sourceKey
				: state.editingBaseId == null) &&
			isDeepStrictEqual(expectedSource, video.source) &&
			upload.rawFileKey === sourceKey &&
			upload.startedAt.toISOString() === operation.startedAt,
	);
}

export async function withEditOperation<T>(
	videoId: string,
	sourceKey: string,
	operation: EditOperation,
	plan: (
		database: CloudflareDatabase,
		snapshot: AtomicSnapshot,
		video: typeof videos.$inferSelect,
		upload: typeof videoUploads.$inferSelect,
		state: EditProcessingState,
	) => Promise<AtomicPlan<T>>,
): Promise<T> {
	const database = db();
	return atomic(database, async (snapshot) => {
		const [video] = await snapshot.read((reader) =>
			reader
				.select()
				.from(videos)
				.where(and(eq(videos.id, videoId as Video.VideoId), writableVideo)),
		);
		const [upload] = await snapshot.read((reader) =>
			reader
				.select()
				.from(videoUploads)
				.where(eq(videoUploads.videoId, videoId as Video.VideoId)),
		);
		const [job] = await snapshot.read((reader) =>
			reader
				.select({ errorCode: videoProcessingJobs.errorCode })
				.from(videoProcessingJobs)
				.where(eq(videoProcessingJobs.videoId, videoId as Video.VideoId)),
		);
		const state = getEditProcessingState(video?.metadata ?? null);
		if (
			!video ||
			!upload ||
			!state ||
			job?.errorCode === "video-deleting" ||
			!matchesEditOperation(video, upload, sourceKey, operation)
		)
			throw new FatalError("Edit operation has been replaced");
		await requireOwnedVideo(snapshot, video.id, video.ownerId);
		return plan(database, snapshot, video, upload, state);
	});
}

export function getCompletedEdit(metadata: VideoMetadata | null) {
	if (
		!metadata ||
		typeof metadata !== "object" ||
		!("completedVideoEdit" in metadata)
	)
		return undefined;
	const parsed = z
		.object({
			token: z.string(),
			startedAt: z.string(),
			transcriptRemapped: z.boolean(),
		})
		.safeParse(metadata.completedVideoEdit);
	return parsed.success ? parsed.data : undefined;
}

export async function clearPendingEdit(
	videoId: string,
	sourceKey: string,
	operation: EditOperation,
): Promise<void> {
	const database = db();
	await atomic(database, async (snapshot) => {
		const statements: AtomicStatement[] = [];
		const [video] = await snapshot.read((reader) =>
			reader
				.select()
				.from(videos)
				.where(and(writableVideo, eq(videos.id, videoId as Video.VideoId))),
		);
		const [upload] = await snapshot.read((reader) =>
			reader
				.select()
				.from(videoUploads)
				.where(eq(videoUploads.videoId, videoId as Video.VideoId)),
		);
		if (!video || !matchesEditOperation(video, upload, sourceKey, operation))
			return { statements, result: undefined };
		const state = getEditProcessingState(video.metadata);
		if (state?.dispatch !== "pending") return { statements, result: undefined };
		statements.push(
			database
				.update(videos)
				.set({ metadata: withoutEditProcessing(video.metadata) })
				.where(eq(videos.id, video.id)),
		);
		statements.push(
			database.delete(videoUploads).where(eq(videoUploads.videoId, video.id)),
		);
		return { statements, result: undefined };
	});
}

export function getEditOutputKeys(
	ownerId: string,
	videoId: string,
	operation: EditOperation,
) {
	const prefix = `${ownerId}/${videoId}/.recording/outputs/edit-${operation.token}`;
	return {
		outputKey: `${prefix}/result.mp4`,
		thumbnailKey: `${prefix}/thumbnail.jpg`,
		previewKey: `${prefix}/preview.gif`,
	};
}

export async function clearFailedEdit(
	videoId: string,
	sourceKey: string,
	operation: EditOperation,
): Promise<void> {
	const database = db();
	await atomic(database, async (snapshot) => {
		const statements: AtomicStatement[] = [];
		const [video] = await snapshot.read((reader) =>
			reader
				.select()
				.from(videos)
				.where(and(writableVideo, eq(videos.id, videoId as Video.VideoId))),
		);
		const [upload] = await snapshot.read((reader) =>
			reader
				.select()
				.from(videoUploads)
				.where(eq(videoUploads.videoId, videoId as Video.VideoId)),
		);
		if (!video || !matchesEditOperation(video, upload, sourceKey, operation))
			return { statements, result: undefined };
		const state = getEditProcessingState(video.metadata);
		statements.push(
			database
				.update(videos)
				.set({
					metadata: withoutEditProcessing(video.metadata),
					...(state?.resultCommitted ? { transcriptionStatus: null } : {}),
				})
				.where(eq(videos.id, video.id)),
		);
		statements.push(
			database.delete(videoUploads).where(eq(videoUploads.videoId, video.id)),
		);
		return { statements, result: undefined };
	});
}
