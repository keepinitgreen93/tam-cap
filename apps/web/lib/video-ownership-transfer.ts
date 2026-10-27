import { createHash } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import type { CloudflareDatabase } from "@cap/database/cloudflare";
import {
	requireActiveOrganization,
	requireOrganizationMember,
} from "@cap/database/cloudflare/access";
import type {
	AtomicSnapshot,
	AtomicStatement,
} from "@cap/database/cloudflare/atomic";
import * as Db from "@cap/database/cloudflare/schema";
import {
	metadataWithTranscriptPublication,
	prepareTranscriptPublication,
	readTranscriptArtifacts,
} from "@cap/database/cloudflare/transcript-publication";
import { Storage } from "@cap/web-backend/src/Storage/index";
import {
	type Folder,
	Organisation,
	S3Bucket,
	Storage as StorageDomain,
	User,
	Video,
} from "@cap/web-domain";
import { and, eq, isNull, type SQLWrapper, sql } from "drizzle-orm";
import { Effect, Option } from "effect";
import { FatalError } from "workflow";
import {
	type ContentTransferPayload,
	type ContentTransferVideoPlan,
	getContentTransferStorageBlockReason,
} from "./content-transfer";
import { getOwnerOriginalKey } from "./loom-original-key";
import { isStorageObjectNotFound } from "./storage-not-found";
import { runWorkflowPromise } from "./workflow-runtime";

function makeStorageVideo(input: {
	id: string;
	ownerId: string;
	orgId: string;
	bucketId: string | null;
	storageIntegrationId: string | null;
}) {
	return Video.Video.make({
		id: Video.VideoId.make(input.id),
		ownerId: User.UserId.make(input.ownerId),
		orgId: Organisation.OrganisationId.make(input.orgId),
		name: "Content transfer",
		public: false,
		source: { type: "MediaConvert" },
		metadata: Option.none(),
		bucketId: Option.fromNullable(input.bucketId).pipe(
			Option.map(S3Bucket.S3BucketId.make),
		),
		storageIntegrationId: Option.fromNullable(input.storageIntegrationId).pipe(
			Option.map(StorageDomain.StorageIntegrationId.make),
		),
		folderId: Option.none(),
		transcriptionStatus: Option.none(),
		width: Option.none(),
		height: Option.none(),
		duration: Option.none(),
		createdAt: new Date(0),
		updatedAt: new Date(0),
	});
}

async function listBucketObjects(
	bucket: Effect.Effect.Success<
		ReturnType<typeof Storage.getAccessForVideo>
	>[0],
	prefix: string,
) {
	const objects: Array<{ key: string; size: number }> = [];
	let continuationToken: string | undefined;
	do {
		const page = await bucket
			.listObjects({ prefix, maxKeys: 1000, continuationToken })
			.pipe(runWorkflowPromise);
		for (const object of page.Contents ?? []) {
			if (!object.Key) continue;
			const size =
				object.Size ??
				(await bucket.headObject(object.Key).pipe(runWorkflowPromise))
					.ContentLength;
			if (
				size === undefined ||
				!Number.isSafeInteger(size) ||
				size < 0 ||
				!object.Key.startsWith(prefix)
			)
				throw new FatalError("Unable to verify transfer source object");
			objects.push({ key: object.Key, size });
		}
		if (page.IsTruncated && !page.NextContinuationToken)
			throw new FatalError("Transfer object listing is incomplete");
		continuationToken = page.IsTruncated
			? page.NextContinuationToken
			: undefined;
	} while (continuationToken);
	return { bucket, prefix, objects };
}

type OwnershipBucket = Effect.Effect.Success<
	ReturnType<typeof Storage.getAccessForVideo>
>[0];
type S3OwnershipBucket = Extract<OwnershipBucket, { provider: "s3" }>;

async function ownershipObjectHash(
	bucket: S3OwnershipBucket,
	key: string,
	size: number,
) {
	const url = await bucket
		.getInternalSignedObjectUrl(key, { expiresIn: 180 })
		.pipe(runWorkflowPromise);
	const response = await fetch(url, { signal: AbortSignal.timeout(120000) });
	if (!response.ok || !response.body)
		throw Error("Unable to read ownership-copy verification bytes");
	const hash = createHash("sha256"),
		reader = response.body.getReader();
	let bytes = 0;
	try {
		for (;;) {
			const { done, value } = await reader.read();
			if (done) break;
			bytes += value.byteLength;
			if (bytes > size) {
				await reader.cancel();
				throw Error("Ownership-copy byte length changed");
			}
			hash.update(value);
		}
	} finally {
		reader.releaseLock();
	}
	if (bytes !== size) throw Error("Ownership-copy byte length changed");
	return hash.digest("hex");
}

async function copyOwnershipObject(
	bucket: S3OwnershipBucket,
	sourceKey: string,
	key: string,
	size: number,
) {
	const head = (objectKey: string) =>
		bucket.headObject(objectKey).pipe(runWorkflowPromise);
	const optionalHead = (objectKey: string) =>
		bucket.headObject(objectKey).pipe(
			Effect.catchIf(isStorageObjectNotFound, () => Effect.succeed(null)),
			runWorkflowPromise,
		);
	const source = await head(sourceKey);
	if (source.ContentLength !== size || !source.ETag)
		throw Error("Ownership-copy source identity changed");
	const reuse = async (existing: Awaited<ReturnType<typeof head>>) => {
		if (existing.ContentLength !== size || !existing.ETag) return false;
		const [sourceHash, destinationHash] = await Promise.all([
			ownershipObjectHash(bucket, sourceKey, size),
			ownershipObjectHash(bucket, key, size),
		]);
		const [afterSource, afterDestination] = await Promise.all([
			head(sourceKey),
			head(key),
		]);
		return (
			sourceHash === destinationHash &&
			afterSource.ETag === source.ETag &&
			afterSource.ContentLength === size &&
			afterDestination.ETag === existing.ETag &&
			afterDestination.ContentLength === size
		);
	};
	const existing = await optionalHead(key);
	if (existing) {
		if (await reuse(existing)) return 0;
		throw Error("Destination ownership-copy media conflicts");
	}
	if (size === 0) {
		await bucket
			.putObject(key, "", { ifNoneMatch: "*", contentType: source.ContentType })
			.pipe(runWorkflowPromise);
		return 1;
	}
	const copyPart = bucket.multipart.copyPart;
	if (!copyPart)
		throw Error("Storage does not support immutable ownership copies");
	const created = await bucket.multipart
		.create(key, {
			ContentType: source.ContentType,
			CacheControl: source.CacheControl,
			ContentDisposition: source.ContentDisposition,
			ContentEncoding: source.ContentEncoding,
			ContentLanguage: source.ContentLanguage,
			Metadata: Object.fromEntries(
				Object.entries(source.Metadata ?? {}).filter(
					(entry): entry is [string, string] => typeof entry[1] === "string",
				),
			),
		})
		.pipe(runWorkflowPromise);
	if (!created.UploadId)
		throw Error("Ownership copy did not return an upload receipt");
	const uploadId = created.UploadId,
		partSize = Math.max(128 * 1024 ** 2, Math.ceil(size / 10000)),
		partCount = Math.ceil(size / partSize);
	let complete = false;
	try {
		const parts = [];
		for (let number = 1; number <= partCount; number++) {
			const start = (number - 1) * partSize;
			const part = await copyPart(key, uploadId, number, {
				CopySource: `${bucket.bucketName}/${sourceKey.split("/").map(encodeURIComponent).join("/")}`,
				CopySourceIfMatch: source.ETag,
				CopySourceRange: `bytes=${start}-${Math.min(size, start + partSize) - 1}`,
			}).pipe(runWorkflowPromise);
			if (!part.CopyPartResult?.ETag)
				throw Error("Ownership copy returned an incomplete part");
			parts.push({ PartNumber: number, ETag: part.CopyPartResult.ETag });
		}
		const result = await bucket.multipart
			.complete(key, uploadId, {
				MultipartUpload: { Parts: parts },
				IfNoneMatch: "*",
			})
			.pipe(runWorkflowPromise);
		const [afterSource, afterDestination] = await Promise.all([
			head(sourceKey),
			head(key),
		]);
		if (
			afterSource.ETag !== source.ETag ||
			afterSource.ContentLength !== size ||
			!result.ETag ||
			afterDestination.ETag !== result.ETag ||
			afterDestination.ContentLength !== size
		)
			throw Error("Ownership-copy identity changed during verification");
		complete = true;
	} catch (error) {
		const destination = await optionalHead(key);
		if (!destination || !(await reuse(destination))) throw error;
		complete = true;
	} finally {
		if (!complete)
			await bucket.multipart.abort(key, uploadId).pipe(
				Effect.catchAll(() =>
					Effect.logWarning("Ownership copy upload awaits provider cleanup"),
				),
				runWorkflowPromise,
			);
	}
	return 1;
}

async function copyAndVerifyObjects({
	payload,
	item,
}: {
	payload: Pick<ContentTransferPayload, "organizationId" | "targetUserId">;
	item: Pick<
		ContentTransferVideoPlan,
		"videoId" | "sourceOwnerId" | "name" | "bucketId" | "storageIntegrationId"
	>;
}) {
	const [bucket] = await Storage.getAccessForVideo(
		makeStorageVideo({
			id: item.videoId,
			ownerId: item.sourceOwnerId,
			orgId: payload.organizationId,
			bucketId: item.bucketId,
			storageIntegrationId: item.storageIntegrationId,
		}),
		{ resolvePublishedOutput: false },
	).pipe(runWorkflowPromise);
	if (bucket.provider !== "s3")
		throw Error("Ownership transfer for linked Drive storage is not supported");
	const prefix = `${item.sourceOwnerId}/${item.videoId}/`,
		destinationPrefix = `${payload.targetUserId}/${item.videoId}/`;
	const listed = await listBucketObjects(bucket, prefix);
	const media = (key: string, base: string) =>
		!key.startsWith(`${base}.transcripts/`) &&
		!key.startsWith(`${base}transcription`);
	const objects = listed.objects.filter((object) => media(object.key, prefix));
	if (objects.length === 0)
		throw new FatalError(`No media objects were found for ${item.name}`);
	let copiedObjects = 0;
	for (let offset = 0; offset < objects.length; offset += 4) {
		const results = await Promise.allSettled(
			objects.slice(offset, offset + 4).map(async (object) => {
				const key = `${destinationPrefix}${object.key.slice(prefix.length)}`;
				return copyOwnershipObject(bucket, object.key, key, object.size);
			}),
		);
		for (const result of results) {
			if (result.status === "rejected") throw result.reason;
			copiedObjects += result.value;
		}
	}
	return {
		bucket,
		prefix,
		objects,
		allObjects: listed.objects,
		copiedObjects,
		destinationPrefix,
	};
}

export async function loadVideoOwnershipTransfer(
	snapshot: AtomicSnapshot,
	videoId: Video.VideoId,
) {
	const [row] = await snapshot.read((reader) =>
		reader
			.select({
				video: Db.videos,
				bucketOwnerId: Db.s3Buckets.ownerId,
				bucketOrganizationId: Db.s3Buckets.organizationId,
				bucketActive: Db.s3Buckets.active,
				storageIntegrationOwnerId: Db.storageIntegrations.ownerId,
				storageIntegrationOrganizationId: Db.storageIntegrations.organizationId,
				storageIntegrationStatus: Db.storageIntegrations.status,
			})
			.from(Db.videos)
			.leftJoin(Db.s3Buckets, eq(Db.videos.bucket, Db.s3Buckets.id))
			.leftJoin(
				Db.storageIntegrations,
				eq(Db.videos.storageIntegrationId, Db.storageIntegrations.id),
			)
			.where(eq(Db.videos.id, videoId))
			.limit(1),
	);
	if (!row) throw Error("Recording no longer exists");
	await requireActiveOrganization(snapshot, row.video.orgId);
	const [[edit], [upload], [job]] = await Promise.all([
		snapshot.read((reader) =>
			reader
				.select()
				.from(Db.videoEdits)
				.where(eq(Db.videoEdits.videoId, videoId))
				.limit(1),
		),
		snapshot.read((reader) =>
			reader
				.select()
				.from(Db.videoUploads)
				.where(eq(Db.videoUploads.videoId, videoId))
				.limit(1),
		),
		snapshot.read((reader) =>
			reader
				.select()
				.from(Db.videoProcessingJobs)
				.where(eq(Db.videoProcessingJobs.videoId, videoId))
				.limit(1),
		),
	]);
	return {
		...row,
		edit: edit ?? null,
		upload: upload ?? null,
		job: job ?? null,
	};
}

export type VideoOwnershipTransferState = Awaited<
	ReturnType<typeof loadVideoOwnershipTransfer>
>;

function replaceOwnedKeys<T>(
	value: T,
	sourcePrefix: string,
	destinationPrefix: string,
): T {
	const replace = (entry: unknown): unknown => {
		if (typeof entry === "string")
			return entry.startsWith(sourcePrefix)
				? `${destinationPrefix}${entry.slice(sourcePrefix.length)}`
				: entry;
		if (Array.isArray(entry)) return entry.map(replace);
		if (entry && typeof entry === "object")
			return Object.fromEntries(
				Object.entries(entry).map(([key, item]) => [key, replace(item)]),
			);
		return entry;
	};
	return replace(value) as T;
}

export async function prepareVideoOwnershipTransfer(
	current: VideoOwnershipTransferState,
	targetUserId: User.UserId,
) {
	const video = current.video;
	if (
		(current.upload && current.upload.phase !== "complete") ||
		video.source.type === "desktopSegments" ||
		video.transcriptionStatus === "PROCESSING" ||
		video.metadata?.editProcessing ||
		video.metadata?.aiGenerationStatus === "PROCESSING" ||
		video.metadata?.loomDeferredProcessing?.status === "started" ||
		(current.job &&
			["committing", "processing", "retry", "queued"].includes(
				current.job.state,
			)) ||
		current.job?.errorCode === "video-deleting"
	)
		throw Error("Recording is not ready to transfer");
	const sourcePrefix = `${video.ownerId}/${video.id}/`,
		destinationPrefix = `${targetUserId}/${video.id}/`;
	const ownerChanged = video.ownerId !== targetUserId;
	if (!ownerChanged)
		return {
			current,
			targetUserId,
			targetVideo: video,
			copied: null,
			copiedObjects: 0,
			sourcePrefix,
			destinationPrefix,
		};
	if (video.storageIntegrationId)
		throw Error("Ownership transfer for linked Drive storage is not supported");
	const reason = getContentTransferStorageBlockReason({
		sourceOwnerId: video.ownerId,
		targetUserId,
		organizationId: video.orgId,
		bucketId: video.bucket,
		bucketOwnerId: current.bucketOwnerId,
		bucketOrganizationId: current.bucketOrganizationId,
		storageIntegrationId: video.storageIntegrationId,
		storageIntegrationOwnerId: current.storageIntegrationOwnerId,
		storageIntegrationOrganizationId: current.storageIntegrationOrganizationId,
	});
	if (
		reason ||
		(video.bucket && !current.bucketActive) ||
		(video.storageIntegrationId &&
			current.storageIntegrationStatus !== "active")
	)
		throw Error(reason ?? "Recording storage is unavailable");
	const copied = await copyAndVerifyObjects({
		payload: { targetUserId, organizationId: video.orgId },
		item: {
			videoId: video.id,
			sourceOwnerId: video.ownerId,
			name: video.name,
			bucketId: video.bucket,
			storageIntegrationId: video.storageIntegrationId,
		},
	});
	const targetMetadata = { ...video.metadata };
	for (const key of [
		"transcriptPublication",
		"transcriptionRun",
		"editTranscriptBackfill",
		"liveTranscript",
		"processingRun",
		"completedVideoEdit",
		"desktopRecordingUpload",
		"agentUpload",
		"loomImportRun",
		"loomImportUpload",
		"aiGenerationRun",
	] as const)
		delete targetMetadata[key];
	if (
		targetMetadata.aiGenerationStatus === "QUEUED" ||
		targetMetadata.aiGenerationStatus === "ERROR"
	)
		delete targetMetadata.aiGenerationStatus;
	if (targetMetadata.loomDeferredProcessing)
		targetMetadata.loomDeferredProcessing = {
			...targetMetadata.loomDeferredProcessing,
			rawFileKey:
				getOwnerOriginalKey(
					targetMetadata.loomDeferredProcessing.rawFileKey,
					targetUserId,
					video.id,
				) ?? targetMetadata.loomDeferredProcessing.rawFileKey,
		};
	const targetVideo = {
		...video,
		ownerId: targetUserId,
		source: replaceOwnedKeys(video.source, sourcePrefix, destinationPrefix),
		metadata: targetMetadata,
	};
	const sourceStore = {
		getText: async (key: string) =>
			Option.getOrNull(
				await copied.bucket.getObject(key).pipe(runWorkflowPromise),
			),
	};
	const artifacts = await readTranscriptArtifacts(video, sourceStore);
	const prepared = await prepareTranscriptPublication({
		video: targetVideo,
		store: {
			...sourceStore,
			put: async (key, value, contentType) =>
				copied.bucket
					.putObject(key, value, { contentType })
					.pipe(runWorkflowPromise),
			delete: async (key) =>
				copied.bucket.deleteObjects([{ Key: key }]).pipe(runWorkflowPromise),
		},
		...artifacts,
	});
	targetVideo.metadata = metadataWithTranscriptPublication(
		targetVideo,
		prepared,
		targetMetadata,
	);
	return {
		current,
		targetUserId,
		targetVideo,
		copied,
		copiedObjects:
			copied.copiedObjects +
			Number(prepared.pointer.vtt) +
			Number(prepared.pointer.edit),
		sourcePrefix,
		destinationPrefix,
	};
}
export type PreparedVideoOwnershipTransfer = Awaited<
	ReturnType<typeof prepareVideoOwnershipTransfer>
>;

export async function planVideoOwnershipTransfer(
	snapshot: AtomicSnapshot,
	database: CloudflareDatabase,
	prepared: PreparedVideoOwnershipTransfer,
	options: {
		folderId: Folder.FolderId | null;
		organizationId: Organisation.OrganisationId;
		now: Date;
	},
): Promise<AtomicStatement[]> {
	const {
		current,
		targetUserId,
		targetVideo,
		copied,
		sourcePrefix,
		destinationPrefix,
	} = prepared;
	const videoId = current.video.id;
	if (options.organizationId !== current.video.orgId)
		throw Error("Ownership transfer must remain in its organization");
	await requireOrganizationMember(
		snapshot,
		options.organizationId,
		targetUserId,
	);
	const locked = await loadVideoOwnershipTransfer(snapshot, videoId);
	if (!isDeepStrictEqual(locked, current))
		throw Error("Recording changed during media copying");
	if (options.folderId) {
		const folderId = options.folderId;
		const [folder] = await snapshot.read((reader) =>
			reader
				.select({ id: Db.folders.id })
				.from(Db.folders)
				.where(
					and(
						eq(Db.folders.id, folderId),
						eq(Db.folders.organizationId, options.organizationId),
						eq(Db.folders.createdById, targetUserId),
						isNull(Db.folders.spaceId),
						eq(Db.folders.public, false),
					),
				)
				.limit(1),
		);
		if (!folder)
			throw Error("Destination folder is missing or no longer private");
	}
	if (copied) {
		const keys = new Set(copied.objects.map((object) => object.key));
		const deferred = current.video.metadata?.loomDeferredProcessing;
		if (deferred?.status === "pending") {
			const originalKey = getOwnerOriginalKey(
				deferred.rawFileKey,
				current.video.ownerId,
				videoId,
			);
			if (!originalKey || !keys.has(originalKey))
				throw Error("Deferred original changed during media copying");
		}
		const comments = await snapshot.read((reader) =>
			reader
				.select({
					mediaKey: Db.comments.mediaKey,
					mediaMeta: Db.comments.mediaMeta,
				})
				.from(Db.comments)
				.where(eq(Db.comments.videoId, videoId)),
		);
		const references = (value: unknown): string[] =>
			typeof value === "string" && value.startsWith(sourcePrefix)
				? [value]
				: Array.isArray(value)
					? value.flatMap(references)
					: value && typeof value === "object"
						? Object.values(value).flatMap(references)
						: [];
		for (const key of [
			...references(current.video.source),
			...(current.edit ? [current.edit.sourceKey] : []),
		])
			if (!key.startsWith(sourcePrefix) || !keys.has(key))
				throw Error("Recording source changed during media copying");
		for (const comment of comments)
			for (const key of [comment.mediaKey, comment.mediaMeta?.thumbnailKey])
				if (key && (!key.startsWith(sourcePrefix) || !keys.has(key)))
					throw Error("Comment media changed during copying");
	}
	const changed = current.video.ownerId !== targetUserId;
	const statements: AtomicStatement[] = [
		database
			.update(Db.videos)
			.set({
				ownerId: targetUserId,
				folderId: options.folderId,
				...(changed
					? { source: targetVideo.source, metadata: targetVideo.metadata }
					: {}),
				updatedAt: options.now,
			})
			.where(eq(Db.videos.id, videoId)),
	];
	if (changed) {
		const rewrite = (column: SQLWrapper) =>
			sql`case when substr(${column},1,${sourcePrefix.length}) = ${sourcePrefix} then ${destinationPrefix} || substr(${column},${sourcePrefix.length + 1}) else ${column} end`;
		statements.push(
			database
				.update(Db.videoUploads)
				.set({ rawFileKey: rewrite(Db.videoUploads.rawFileKey) })
				.where(eq(Db.videoUploads.videoId, videoId)),
			database
				.update(Db.videoEdits)
				.set({ sourceKey: rewrite(Db.videoEdits.sourceKey) })
				.where(eq(Db.videoEdits.videoId, videoId)),
			database
				.update(Db.comments)
				.set({
					mediaKey: rewrite(Db.comments.mediaKey),
					mediaMeta: sql`case when json_type(${Db.comments.mediaMeta},'$.thumbnailKey') = 'text' and substr(json_extract(${Db.comments.mediaMeta},'$.thumbnailKey'),1,${sourcePrefix.length}) = ${sourcePrefix} then json_set(${Db.comments.mediaMeta},'$.thumbnailKey',${destinationPrefix} || substr(json_extract(${Db.comments.mediaMeta},'$.thumbnailKey'),${sourcePrefix.length + 1})) else ${Db.comments.mediaMeta} end`,
				})
				.where(eq(Db.comments.videoId, videoId)),
			database
				.delete(Db.videoProcessingJobs)
				.where(eq(Db.videoProcessingJobs.videoId, videoId)),
		);
	}
	return statements;
}

export const retainedOwnershipTransferMediaReason =
	"Old media copies retained for ABA safety until fenced cleanup is available";
