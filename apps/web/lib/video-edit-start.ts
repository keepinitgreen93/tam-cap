import "server-only";
import { randomUUID } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import { db } from "@cap/database/cloudflare/application";
import { type AtomicStatement, atomic } from "@cap/database/cloudflare/atomic";
import {
	videoEdits,
	videos,
	videoUploads,
} from "@cap/database/cloudflare/schema";
import type {
	VideoEditSpec,
	VideoMetadata,
	VideoProcessingRun,
} from "@cap/database/types";
import { Storage } from "@cap/web-backend";
import { writableVideo } from "@cap/web-backend/src/Videos/persistence";
import { and, eq } from "drizzle-orm";
import { Effect } from "effect";
import { isStorageObjectNotFound } from "@/lib/storage-not-found";
import type { EditOperation } from "@/lib/video-edit-operation";
import { getEditSourceKey } from "@/lib/video-edit-processing";
import { getVideoEditingBase } from "@/lib/video-editing-base";
import {
	areEditSpecsEquivalent,
	createIdentityEditSpec,
} from "@/lib/video-edits";
import { decodeStorageVideo } from "@/lib/video-storage";
import { isVideoStorageKey } from "@/lib/video-storage-key";
import { runWorkflowPromise } from "@/lib/workflow-runtime";

function getResultKey(ownerId: string, videoId: string) {
	return `${ownerId}/${videoId}/result.mp4`;
}

type CompletedProcessingReceipt = {
	upload: typeof videoUploads.$inferSelect;
	run: VideoProcessingRun;
};

export function getCompletedProcessingReceipt(
	video: typeof videos.$inferSelect,
	upload: typeof videoUploads.$inferSelect | undefined,
): CompletedProcessingReceipt | undefined {
	const run = video.metadata?.processingRun;
	const completedAt = Date.parse(run?.completedAt ?? "");
	if (
		!upload ||
		upload.videoId !== video.id ||
		upload.phase !== "complete" ||
		upload.processingProgress !== 100 ||
		upload.processingError !== null ||
		video.metadata?.editProcessing ||
		!run ||
		run.state !== "complete" ||
		!run.token ||
		!run.attemptId ||
		run.error ||
		!Number.isFinite(completedAt) ||
		upload.startedAt.getTime() > completedAt ||
		upload.updatedAt.getTime() < completedAt ||
		run.ownerId !== video.ownerId ||
		run.organizationId !== video.orgId ||
		run.bucketId !== video.bucket ||
		run.storageIntegrationId !== video.storageIntegrationId ||
		upload.rawFileKey !== run.rawFileKey ||
		!isVideoStorageKey(video, run.rawFileKey) ||
		!run.outputKey.startsWith(
			`${video.ownerId}/${video.id}/.recording/outputs/`,
		) ||
		!isVideoStorageKey(video, run.outputKey) ||
		(video.source.type !== "desktopMP4" && video.source.type !== "webMP4") ||
		video.source.outputKey !== run.outputKey
	)
		return undefined;
	return { upload, run };
}

export async function objectExists(
	bucket: Awaited<ReturnType<typeof getVideoBucket>>,
	key: string,
) {
	return await bucket.headObject(key).pipe(
		Effect.as(true),
		Effect.catchIf(isStorageObjectNotFound, () => Effect.succeed(false)),
		runWorkflowPromise,
	);
}

export async function getVideoBucket(video: typeof videos.$inferSelect) {
	const [bucket] = await Storage.getAccessForVideo(
		decodeStorageVideo(video),
	).pipe(runWorkflowPromise);
	return bucket;
}

export async function ensureOriginalSourceCopy(
	video: typeof videos.$inferSelect,
	sourceKey = getEditSourceKey(video.ownerId, video.id, video.metadata),
	copyIfMissing = false,
) {
	const bucket = await getVideoBucket(video);
	const hasSource = await objectExists(bucket, sourceKey);

	if (!hasSource) {
		if (!copyIfMissing)
			throw new Error("Original editing base is no longer available");
		const resultKey =
			(video.source.type === "desktopMP4" || video.source.type === "webMP4") &&
			video.source.outputKey
				? video.source.outputKey
				: getResultKey(video.ownerId, video.id);
		if (!isVideoStorageKey(video, resultKey))
			throw new Error("Invalid video source");
		await bucket
			.copyObject(`${bucket.bucketName}/${resultKey}`, sourceKey)
			.pipe(runWorkflowPromise);
	}

	return sourceKey;
}

export async function markEditProcessing({
	video,
	sourceKey,
	previousSpec,
	legacyUpload,
	completedUpload,
	automaticCleanup,
}: {
	video: typeof videos.$inferSelect;
	sourceKey: string;
	previousSpec: VideoEditSpec;
	legacyUpload?: typeof videoUploads.$inferSelect;
	completedUpload?: CompletedProcessingReceipt;
	automaticCleanup?: NonNullable<VideoMetadata["automaticCleanup"]>;
}): Promise<EditOperation> {
	const startedAt = new Date(Math.floor(Date.now() / 1000) * 1000);
	const operation = automaticCleanup?.operation ?? {
		token: randomUUID(),
		startedAt: startedAt.toISOString(),
	};
	if (automaticCleanup) startedAt.setTime(Date.parse(operation.startedAt));
	const database = db();
	await atomic(database, async (snapshot) => {
		const statements: AtomicStatement[] = [];
		const [current] = await snapshot.read((reader) =>
			reader
				.select()
				.from(videos)
				.where(and(writableVideo, eq(videos.id, video.id))),
		);
		if (
			!current ||
			current.ownerId !== video.ownerId ||
			current.orgId !== video.orgId ||
			current.bucket !== video.bucket ||
			current.storageIntegrationId !== video.storageIntegrationId ||
			JSON.stringify(current.source) !== JSON.stringify(video.source) ||
			!isDeepStrictEqual(
				getVideoEditingBase(current),
				getVideoEditingBase(video),
			)
		) {
			throw new Error("Video changed before the edit could start");
		}
		const [upload] = await snapshot.read((reader) =>
			reader
				.select()
				.from(videoUploads)
				.where(eq(videoUploads.videoId, video.id)),
		);
		const completedCurrent = getCompletedProcessingReceipt(current, upload);
		if (
			completedUpload &&
			completedCurrent &&
			isDeepStrictEqual(completedCurrent, completedUpload)
		) {
			statements.push(
				database.delete(videoUploads).where(eq(videoUploads.videoId, video.id)),
			);
		} else if (
			legacyUpload &&
			upload &&
			!current.metadata?.editProcessing &&
			upload.rawFileKey === legacyUpload.rawFileKey &&
			upload.startedAt.getTime() === legacyUpload.startedAt.getTime() &&
			upload.updatedAt.getTime() === legacyUpload.updatedAt.getTime() &&
			upload.phase === legacyUpload.phase
		) {
			statements.push(
				database.delete(videoUploads).where(eq(videoUploads.videoId, video.id)),
			);
		} else if (upload || current.metadata?.editProcessing) {
			throw new Error("Video is already uploading or processing");
		}
		const [currentEdit] = await snapshot.read((reader) =>
			reader.select().from(videoEdits).where(eq(videoEdits.videoId, video.id)),
		);
		if (
			automaticCleanup &&
			(currentEdit ||
				current.metadata?.completedVideoEdit ||
				current.metadata?.automaticCleanup ||
				current.metadata?.transcriptPublication?.id !==
					automaticCleanup.transcriptId)
		) {
			throw new Error("Automatic cleanup was superseded");
		}
		const base = getVideoEditingBase(current);
		if (
			(base && base.sourceKey !== sourceKey) ||
			(currentEdit && currentEdit.sourceKey !== sourceKey)
		)
			throw new Error(
				"Video editing base changed before this edit could start",
			);
		if (
			!areEditSpecsEquivalent(
				currentEdit?.editSpec ??
					createIdentityEditSpec(
						getVideoEditingBase(current)?.duration ??
							current.duration ??
							previousSpec.sourceDuration,
					),
				previousSpec,
			)
		) {
			throw new Error("Video edits changed before this edit could start");
		}
		statements.push(
			database.insert(videoUploads).values({
				videoId: video.id,
				uploaded: 0,
				total: 0,
				mode: "singlepart",
				phase: "processing",
				processingProgress: 0,
				processingMessage: "Starting video edit...",
				processingError: null,
				rawFileKey: sourceKey,
				startedAt,
				updatedAt: startedAt,
			}),
		);
		const metadata = {
			...(current.metadata ?? {}),
			...(automaticCleanup ? { automaticCleanup } : {}),
			editProcessing: {
				...operation,
				editingBaseId: base?.id ?? null,
				sourceKey,
				ownerId: current.ownerId,
				bucket: current.bucket,
				storageIntegrationId: current.storageIntegrationId,
				source: JSON.stringify(current.source),
				dispatch: "pending" as const,
			},
		};
		statements.push(
			database
				.update(videos)
				.set({ metadata })
				.where(and(writableVideo, eq(videos.id, video.id))),
		);
		return { statements, result: undefined };
	});
	return operation;
}
