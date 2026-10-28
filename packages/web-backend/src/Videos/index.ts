import { getVideoEditingBase } from "@cap/database/cloudflare/editing-base";
import * as Db from "@cap/database/cloudflare/schema";
import {
	metadataWithTranscriptPublication,
	prepareTranscriptPublication,
	readTranscriptArtifacts,
	type TranscriptVideo,
} from "@cap/database/cloudflare/transcript-publication";
import { nanoId } from "@cap/database/helpers";

import { buildEnv, NODE_ENV, serverEnv } from "@cap/env";
import { dub } from "@cap/utils";
import {
	CurrentUser,
	type Folder,
	Policy,
	Storage as StorageDomain,
	Video,
} from "@cap/web-domain";
import * as Dz from "drizzle-orm";
import { Array as Arr, Effect, Exit, Option } from "effect";
import type { Schema } from "effect/Schema";
import { Analytics } from "../Analytics/index.ts";
import { CloudflareDatabase as Database } from "../CloudflareDatabase.ts";
import { Storage as StorageService } from "../Storage/index.ts";
import {
	getPublishedRecordingCopyKeys,
	getPublishedRecordingThumbnailKey,
	isInternalRecordingKey,
} from "../Storage/recording-output.ts";
import { activeVideo, updateVideoUploadProgress } from "./persistence.ts";
import { VideosPolicy } from "./VideosPolicy.ts";
import type { CreateVideoInput as RepoCreateVideoInput } from "./VideosRepo.ts";
import { VideosRepo } from "./VideosRepo.ts";

const DEFAULT_ANALYTICS_RANGE_DAYS = 90;
const buildPathname = (videoId: Video.VideoId) => `/s/${videoId}`;
const SCREENSHOT_OBJECT_KEY_SUFFIXES = [
	"screenshot/screen-capture.png",
	"screenshot/screen-capture.jpg",
	"screenshot/screen-capture.jpeg",
	"screen-capture.jpg",
	"screen-capture.jpeg",
];
type ScreenshotObject = {
	Key?: string | null;
	LastModified?: Date | string | number | null;
};
type ScreenshotCandidate = {
	key: string;
	suffixIndex: number;
	lastModified: number | null;
};
const getScreenshotObjectTime = (value: ScreenshotObject["LastModified"]) => {
	if (value == null) return null;
	const time =
		value instanceof Date ? value.getTime() : new Date(value).getTime();
	return Number.isFinite(time) ? time : null;
};
export const findScreenshotObjectKey = (
	contents: ReadonlyArray<ScreenshotObject>,
) => {
	const candidates = contents
		.map((item): ScreenshotCandidate | null => {
			const key = item.Key;
			if (!key) return null;
			const suffixIndex = SCREENSHOT_OBJECT_KEY_SUFFIXES.findIndex((suffix) =>
				key.endsWith(suffix),
			);
			if (suffixIndex < 0) return null;
			return {
				key,
				suffixIndex,
				lastModified: getScreenshotObjectTime(item.LastModified),
			};
		})
		.filter((item): item is ScreenshotCandidate => item !== null)
		.sort((a, b) => {
			if (a.lastModified !== null || b.lastModified !== null) {
				const timeDiff =
					(b.lastModified ?? Number.NEGATIVE_INFINITY) -
					(a.lastModified ?? Number.NEGATIVE_INFINITY);
				if (timeDiff !== 0) return timeDiff;
			}
			return a.suffixIndex - b.suffixIndex;
		});

	return candidates[0]?.key ?? null;
};
const getFileExtensionFromKey = (fileKey: string) => {
	const fileName = fileKey.split("/").at(-1) ?? "";
	const extension = fileName.split(".").at(-1)?.toLowerCase();

	if (!extension || extension === fileName.toLowerCase()) {
		return null;
	}

	return extension;
};

type UploadProgressUpdateInput = Schema.Type<
	typeof Video.UploadProgressUpdateInput
>;
type InstantRecordingCreateInput = Schema.Type<
	typeof Video.InstantRecordingCreateInput
>;
type OptionValue<T> = T extends Option.Option<infer Value> ? Value : never;
type RepoMetadataValue = OptionValue<RepoCreateVideoInput["metadata"]>;
type RepoTranscriptionStatusValue = OptionValue<
	RepoCreateVideoInput["transcriptionStatus"]
>;

const nextObjectPage = (
	page: { IsTruncated?: boolean; NextContinuationToken?: string },
	seen: Set<string>,
) => {
	const next = page.NextContinuationToken;
	if ((page.IsTruncated && !next) || (next && seen.has(next))) {
		return Effect.fail(
			new StorageDomain.StorageError({
				cause: new Error("Storage returned an invalid continuation token"),
			}),
		);
	}
	if (next) seen.add(next);
	return Effect.succeed(next);
};

export class Videos extends Effect.Service<Videos>()("Videos", {
	effect: Effect.gen(function* () {
		const db = yield* Database;
		const repo = yield* VideosRepo;
		const policy = yield* VideosPolicy;
		const storage = yield* StorageService;
		const analytics = yield* Analytics;

		const getByIdForViewing = (id: Video.VideoId) =>
			policy.getViewableById(id).pipe(Effect.withSpan("Videos.getById"));

		const getAnalyticsCounts = Effect.fn("Videos.getAnalyticsCounts")(
			function* (
				analyticsVideos: ReadonlyArray<{ id: Video.VideoId; orgId: string }>,
			) {
				const to = new Date();
				const from = new Date(
					to.getTime() - DEFAULT_ANALYTICS_RANGE_DAYS * 24 * 60 * 60 * 1000,
				);
				const grouped = new Map<string, Video.VideoId[]>();
				for (const video of analyticsVideos) {
					const ids = grouped.get(video.orgId) ?? [];
					ids.push(video.id);
					grouped.set(video.orgId, ids);
				}
				const counts = new Map<string, number>();
				for (const [organizationId, videoIds] of grouped) {
					const rows = yield* analytics.countViews({
						organizationId,
						videoIds,
						from,
						to,
					});
					for (const row of rows)
						counts.set(
							buildPathname(Video.VideoId.make(row.videoId)),
							row.views,
						);
				}
				for (const video of analyticsVideos)
					if (!counts.has(buildPathname(video.id)))
						counts.set(buildPathname(video.id), 0);
				return counts;
			},
		);
		const getAnalyticsBulkInternal = Effect.fn("Videos.getAnalyticsBulk")(
			function* (videoIds: ReadonlyArray<Video.VideoId>) {
				if (videoIds.length === 0)
					return [] as Array<Exit.Exit<{ count: number }, unknown>>;

				const rows = yield* db.use((database) =>
					database
						.select({
							id: Db.videos.id,
							orgId: Db.videos.orgId,
							ownerId: Db.videos.ownerId,
							public: Db.videos.public,
							password: Db.videos.password,
						})
						.from(Db.videos)
						.where(
							Dz.and(
								activeVideo,
								Dz.sql`${Db.videos.id} in (select value from json_each(${JSON.stringify([...new Set(videoIds)])}))`,
							),
						),
				);
				const policyExits = yield* policy.canViewLoadedBulk(
					rows.map(
						(video) => [video, Option.fromNullable(video.password)] as const,
					),
				);
				const resultsById = new Map(
					Arr.zipWith(
						rows,
						policyExits,
						(video, exit) =>
							[video.id, Exit.map(exit, () => Option.some(video))] as const,
					),
				);
				const videoExits = videoIds.map(
					(videoId) =>
						resultsById.get(videoId) ??
						Exit.succeed(Option.none<(typeof rows)[number]>()),
				);
				const analyticsVideos = videoExits.flatMap((exit) => {
					if (!Exit.isSuccess(exit) || Option.isNone(exit.value)) return [];
					const video = exit.value.value;
					return [{ id: video.id, orgId: video.orgId }];
				});
				const countsByPathname = yield* getAnalyticsCounts(analyticsVideos);

				return videoExits.map((exit, index) =>
					Exit.map(exit, () => ({
						count: videoIds[index]
							? (countsByPathname.get(buildPathname(videoIds[index])) ?? 0)
							: 0,
					})),
				);
			},
		);

		const getAnalyticsBulkForOwner = Effect.fn(
			"Videos.getAnalyticsBulkForOwner",
		)(function* (
			videoIds: ReadonlyArray<Video.VideoId>,
			ownerId: (typeof Db.videos.$inferSelect)["ownerId"],
		) {
			if (videoIds.length === 0) return [];
			const uniqueVideoIds = Array.from(new Set(videoIds));
			const rows = yield* db.use((database) =>
				database
					.select({ id: Db.videos.id, orgId: Db.videos.orgId })
					.from(Db.videos)
					.where(
						Dz.and(
							Dz.eq(Db.videos.ownerId, ownerId),
							activeVideo,
							Dz.sql`${Db.videos.id} in (select value from json_each(${JSON.stringify(uniqueVideoIds)}))`,
						),
					),
			);
			const countsByPathname = yield* getAnalyticsCounts(rows);

			return videoIds.map((videoId) => ({
				count: countsByPathname.get(buildPathname(videoId)) ?? 0,
			}));
		});

		return {
			/*
			 * Get a video by ID. Will fail if the user does not have access.
			 */
			// This is only for external use since it does an access check,
			// internal use should prefer the repo directly
			getByIdForViewing,

			/*
			 * Delete a video. Will fail if the user does not have access.
			 */
			delete: Effect.fn("Videos.delete")(function* (videoId: Video.VideoId) {
				const maybeVideo = yield* policy.getOwnedById(videoId);
				if (Option.isNone(maybeVideo))
					return yield* Effect.fail(new Video.NotFoundError());
				const [video] = maybeVideo.value;

				const [bucket] = yield* storage.getAccessForVideo(video);

				yield* repo.prepareDelete(video.id, video.ownerId);

				const prefix = `${video.ownerId}/${video.id}/`;

				let continuationToken: string | undefined;
				const seenTokens = new Set<string>();
				do {
					const listedObjects = yield* bucket.listObjects({
						prefix,
						continuationToken,
					});
					continuationToken = yield* nextObjectPage(listedObjects, seenTokens);
					if (listedObjects.Contents?.length) {
						if (
							listedObjects.Contents.some(
								(content) => !content.Key?.startsWith(prefix),
							)
						) {
							return yield* Effect.fail(
								new StorageDomain.StorageError({
									cause: new Error(
										"Storage returned an unexpected recording key",
									),
								}),
							);
						}
						yield* bucket.deleteObjects(
							listedObjects.Contents.map((content) => ({ Key: content.Key })),
						);
					}
				} while (continuationToken);
				yield* repo.delete(video.id, video.ownerId);
				yield* Effect.log(`Deleted video ${video.id}`);
			}),

			/*
			 * Duplicates a video, its metadata, and its media files.
			 * Comments and reactions will not be duplicated or carried over.
			 */
			duplicate: Effect.fn("Videos.duplicate")(function* (
				videoId: Video.VideoId,
			) {
				const maybeVideo = yield* policy.getOwnedById(videoId);
				if (Option.isNone(maybeVideo))
					return yield* Effect.fail(new Video.NotFoundError());
				const [video, password] = maybeVideo.value;

				const [bucket] = yield* storage.getAccessForVideo(video);

				const publishedKeys = new Set(getPublishedRecordingCopyKeys(video));
				const newVideoId = Video.VideoId.make(nanoId());
				if (Option.isSome(yield* repo.getById(newVideoId))) {
					return yield* Effect.fail(
						new StorageDomain.StorageError({
							cause: new Error("Duplicate video id is already in use"),
						}),
					);
				}

				const prefix = `${video.ownerId}/${video.id}/`;
				const newPrefix = `${video.ownerId}/${newVideoId}/`;
				const [sourceEdit] = yield* db.use((database) =>
					database
						.select()
						.from(Db.videoEdits)
						.where(Dz.eq(Db.videoEdits.videoId, video.id))
						.limit(1),
				);
				if (sourceEdit && !sourceEdit.sourceKey.startsWith(prefix))
					return yield* Effect.fail(
						new StorageDomain.StorageError({
							cause: new Error("Original edit source is outside its recording"),
						}),
					);
				const sourceReference: TranscriptVideo = {
					id: video.id,
					ownerId: video.ownerId,
					orgId: video.orgId,
					source: video.source,
					metadata: Option.getOrNull(video.metadata),
					bucket: Option.getOrNull(video.bucketId),
					storageIntegrationId: Option.getOrNull(video.storageIntegrationId),
					duration: Option.getOrNull(video.duration),
					width: Option.getOrNull(video.width),
					height: Option.getOrNull(video.height),
				};
				const copiedMetadata = { ...sourceReference.metadata };
				const editingBase = yield* Effect.try({
					try: () => getVideoEditingBase(sourceReference),
					catch: (cause) => new StorageDomain.StorageError({ cause }),
				});
				if (
					editingBase &&
					sourceEdit &&
					sourceEdit.sourceKey !== editingBase.sourceKey
				)
					return yield* Effect.fail(
						new StorageDomain.StorageError({
							cause: new Error(
								"Original edit source does not match its editing base",
							),
						}),
					);
				if (editingBase)
					copiedMetadata.editingBase = {
						...editingBase,
						sourceKey: `${newPrefix}${editingBase.sourceKey.slice(prefix.length)}`,
					};
				delete copiedMetadata.desktopRecordingUpload;
				delete copiedMetadata.customCreatedAt;
				delete copiedMetadata.editProcessing;
				delete copiedMetadata.completedVideoEdit;
				delete copiedMetadata.processingRun;
				delete copiedMetadata.transcriptionRun;
				delete copiedMetadata.editTranscriptBackfill;
				delete copiedMetadata.liveTranscript;
				delete copiedMetadata.agentUpload;
				delete copiedMetadata.loomImportRun;
				delete copiedMetadata.loomImportUpload;
				delete copiedMetadata.aiGenerationRun;
				if (
					copiedMetadata.aiGenerationStatus === "QUEUED" ||
					copiedMetadata.aiGenerationStatus === "PROCESSING" ||
					copiedMetadata.aiGenerationStatus === "ERROR"
				)
					delete copiedMetadata.aiGenerationStatus;
				const targetReference: TranscriptVideo = {
					...sourceReference,
					id: newVideoId,
					metadata: copiedMetadata,
					source:
						publishedKeys.size > 0
							? {
									type:
										video.source.type === "webMP4" ? "webMP4" : "desktopMP4",
								}
							: video.source,
				};
				const attemptedKeys: string[] = [];
				let publicationAttempted = false;

				const copyObject = (key: string) =>
					Effect.gen(function* () {
						const newKey = `${newPrefix}${key.slice(prefix.length)}`;
						attemptedKeys.push(newKey);
						yield* bucket.copyObjectForRecording(
							`${bucket.bucketName}/${key}`,
							newKey,
						);
					});
				yield* Effect.gen(function* () {
					for (const key of publishedKeys) yield* copyObject(key);
					if (sourceEdit && !publishedKeys.has(sourceEdit.sourceKey))
						yield* copyObject(sourceEdit.sourceKey);
					if (
						editingBase &&
						!publishedKeys.has(editingBase.sourceKey) &&
						editingBase.sourceKey !== sourceEdit?.sourceKey
					)
						yield* copyObject(editingBase.sourceKey);
					let continuationToken: string | undefined;
					const seenTokens = new Set<string>();
					do {
						const allObjects = yield* bucket.listObjects({
							prefix,
							continuationToken,
						});
						continuationToken = yield* nextObjectPage(allObjects, seenTokens);
						for (const object of allObjects.Contents ?? []) {
							const key = object.Key;
							if (!key?.startsWith(prefix)) {
								return yield* Effect.fail(
									new StorageDomain.StorageError({
										cause: new Error(
											"Storage returned an unexpected recording key",
										),
									}),
								);
							}
							if (
								key.includes("/comments/") ||
								isInternalRecordingKey(key) ||
								publishedKeys.has(key) ||
								key === sourceEdit?.sourceKey ||
								key === editingBase?.sourceKey ||
								key.startsWith(`${prefix}transcription`) ||
								(publishedKeys.size > 0 && key.startsWith(`${prefix}segments/`))
							) {
								continue;
							}
							yield* copyObject(key);
						}
					} while (continuationToken);
					const [copyTarget] = yield* storage.getAccessForVideo(video, {
						copyTargetVideoId: newVideoId,
						resolvePublishedOutput: false,
					});
					const sourceStore = {
						getText: async (key: string) =>
							Option.getOrNull(await Effect.runPromise(bucket.getObject(key))),
						put: (key: string, text: string, contentType: string) =>
							Effect.runPromise(bucket.putObject(key, text, { contentType })),
						delete: (key: string) =>
							Effect.runPromise(bucket.deleteObject(key)),
					};
					const targetStore = {
						getText: async (key: string) =>
							Option.getOrNull(
								await Effect.runPromise(copyTarget.getObject(key)),
							),
						put: (key: string, text: string, contentType: string) => {
							attemptedKeys.push(key);
							return Effect.runPromise(
								copyTarget.putObject(key, text, { contentType }),
							);
						},
						delete: (key: string) =>
							Effect.runPromise(copyTarget.deleteObject(key)),
					};
					const artifacts = yield* Effect.tryPromise({
						try: () => readTranscriptArtifacts(sourceReference, sourceStore),
						catch: (cause) => new StorageDomain.StorageError({ cause }),
					});
					const prepared = yield* Effect.tryPromise({
						try: () =>
							prepareTranscriptPublication({
								video: targetReference,
								store: targetStore,
								...artifacts,
							}),
						catch: (cause) => new StorageDomain.StorageError({ cause }),
					});
					const metadata = metadataWithTranscriptPublication(
						targetReference,
						prepared,
						copiedMetadata,
					);
					publicationAttempted = true;
					const hasPassword = Option.isSome(password);
					yield* repo.create(
						{
							ownerId: video.ownerId,
							orgId: video.orgId,
							name: video.name,
							public: video.public,
							source: targetReference.source,
							metadata: Option.some(metadata),
							bucketId: video.bucketId,
							storageIntegrationId: video.storageIntegrationId,
							folderId: video.folderId,
							transcriptionStatus: Option.filter(
								video.transcriptionStatus,
								(status) => status !== "PROCESSING",
							),
							width: video.width,
							height: video.height,
							duration: video.duration,
							...(hasPassword ? { password: password.value } : {}),
						},
						{
							id: newVideoId,
							copySource: { video: sourceReference, edit: sourceEdit ?? null },
							initialEdit: sourceEdit
								? {
										sourceKey: `${newPrefix}${sourceEdit.sourceKey.slice(prefix.length)}`,
										editSpec: sourceEdit.editSpec,
									}
								: undefined,
						},
					);
				}).pipe(
					Effect.onError(() =>
						Effect.gen(function* () {
							if (
								publicationAttempted &&
								Option.isSome(yield* repo.getById(newVideoId))
							) {
								return;
							}
							for (
								let offset = 0;
								offset < attemptedKeys.length;
								offset += 1000
							) {
								yield* bucket.deleteObjects(
									attemptedKeys
										.slice(offset, offset + 1000)
										.map((Key) => ({ Key })),
								);
							}
						}).pipe(
							Effect.catchAllCause(() =>
								Effect.logWarning(
									"Recording duplicate cleanup did not finish",
									{
										videoId: newVideoId,
									},
								),
							),
						),
					),
				);
			}),

			/*
			 * Gets the progress of a video upload.
			 */
			getUploadProgress: Effect.fn("Videos.getUploadProgress")(function* (
				videoId: Video.VideoId,
			) {
				const [result] = yield* db
					.use((db) =>
						db
							.select({
								uploaded: Db.videoUploads.uploaded,
								total: Db.videoUploads.total,
								startedAt: Db.videoUploads.startedAt,
								updatedAt: Db.videoUploads.updatedAt,
								phase: Db.videoUploads.phase,
								processingProgress: Db.videoUploads.processingProgress,
								processingMessage: Db.videoUploads.processingMessage,
								processingError: Db.videoUploads.processingError,
								rawFileKey: Db.videoUploads.rawFileKey,
								processingJobState: Db.videoProcessingJobs.state,
							})
							.from(Db.videoUploads)
							.leftJoin(
								Db.videoProcessingJobs,
								Dz.eq(Db.videoProcessingJobs.videoId, Db.videoUploads.videoId),
							)
							.where(
								Dz.and(
									Dz.eq(Db.videoUploads.videoId, videoId),
									Dz.sql`exists (select 1 from ${Db.videos} where ${Db.videos.id} = ${Db.videoUploads.videoId} and ${activeVideo})`,
								),
							),
					)
					.pipe(Policy.withPublicPolicy(policy.canView(videoId)));

				if (result == null) return Option.none();
				const automaticRetry =
					result.processingJobState === "committing" ||
					result.processingJobState === "queued" ||
					result.processingJobState === "processing" ||
					result.processingJobState === "retry";
				return Option.some(
					new Video.UploadProgress({
						uploaded: result.uploaded,
						total: result.total,
						startedAt: result.startedAt,
						updatedAt: result.updatedAt,
						phase: automaticRetry ? "processing" : result.phase,
						processingProgress: result.processingProgress,
						processingMessage: Option.fromNullable(result.processingMessage),
						processingError: automaticRetry
							? Option.none()
							: Option.fromNullable(result.processingError),
						hasRawFallback: result.rawFileKey != null,
						automaticRetry,
					}),
				);
			}),

			updateUploadProgress: Effect.fn("Videos.updateUploadProgress")(function* (
				input: UploadProgressUpdateInput,
			) {
				const user = yield* CurrentUser;
				const existing = yield* repo.getById(input.videoId);
				if (Option.isNone(existing))
					return yield* Effect.fail(new Video.NotFoundError());
				yield* policy.isOwnerLoaded(existing.value[0]);
				yield* db.use((database) =>
					updateVideoUploadProgress(database, user.id, input),
				);

				return true as const;
			}),

			createInstantRecording: Effect.fn("Videos.createInstantRecording")(
				function* (input: InstantRecordingCreateInput) {
					const user = yield* CurrentUser;

					if (user.activeOrganizationId !== input.orgId)
						return yield* Effect.fail(new Policy.PolicyDeniedError());

					const writable = yield* storage.getWritableAccessForUser(
						user.id,
						input.orgId,
					);
					const bucketId: RepoCreateVideoInput["bucketId"] = writable.bucketId;
					const storageIntegrationId: RepoCreateVideoInput["storageIntegrationId"] =
						writable.storageIntegrationId;
					const folderId: RepoCreateVideoInput["folderId"] =
						input.folderId ?? Option.none<Folder.FolderId>();
					const width: RepoCreateVideoInput["width"] = Option.fromNullable(
						input.width,
					);
					const height: RepoCreateVideoInput["height"] = Option.fromNullable(
						input.height,
					);
					const duration: RepoCreateVideoInput["duration"] =
						Option.fromNullable(input.durationSeconds);

					const now = new Date();
					const formattedDate = `${now.getDate()} ${now.toLocaleString(
						"default",
						{
							month: "long",
						},
					)} ${now.getFullYear()}`;

					const [organization] = yield* db.use((database) =>
						database
							.select()
							.from(Db.organizations)
							.where(
								Dz.and(
									Dz.eq(Db.organizations.id, input.orgId),
									Dz.isNull(Db.organizations.tombstoneAt),
								),
							)
							.limit(1),
					);
					if (!organization)
						return yield* Effect.fail(new Policy.PolicyDeniedError());

					const createData: RepoCreateVideoInput = {
						ownerId: user.id,
						orgId: input.orgId,
						name: `Cap Recording - ${formattedDate}`,
						public:
							organization.defaultVideoVisibility === "private"
								? false
								: serverEnv().CAP_VIDEOS_DEFAULT_PUBLIC,
						source: { type: "webMP4" },
						bucketId,
						storageIntegrationId,
						folderId,
						width,
						height,
						duration,
						metadata: Option.none<RepoMetadataValue>(),
						transcriptionStatus: Option.none<RepoTranscriptionStatusValue>(),
					};
					const videoId = yield* repo.create(createData, {
						initialUpload:
							(input.supportsUploadProgress ?? true)
								? { mode: "singlepart" }
								: undefined,
					});
					const fileKey = `${user.id}/${videoId}/result.mp4`;
					const upload = yield* writable.access.createUploadTarget(fileKey, {
						contentType: "video/mp4",
						fields: {
							"Content-Type": "video/mp4",
							"x-amz-meta-userid": user.id,
							"x-amz-meta-duration": input.durationSeconds
								? input.durationSeconds.toString()
								: "",
							"x-amz-meta-resolution": input.resolution ?? "",
							"x-amz-meta-videocodec": input.videoCodec ?? "",
							"x-amz-meta-audiocodec": input.audioCodec ?? "",
						},
					});
					const canonicalShareUrl = `${serverEnv().WEB_URL}/s/${videoId}`;

					const verifiedCustomDomain = yield* db
						.use((db) =>
							db
								.select({
									customDomain: Db.organizations.customDomain,
									domainVerified: Db.organizations.domainVerified,
								})
								.from(Db.organizations)
								.where(Dz.eq(Db.organizations.id, input.orgId))
								.limit(1),
						)
						.pipe(
							Effect.map(([org]) =>
								org?.customDomain && org.domainVerified
									? org.customDomain.startsWith("http://") ||
										org.customDomain.startsWith("https://")
										? org.customDomain
										: `https://${org.customDomain}`
									: null,
							),
							Effect.catchAll(() => Effect.succeed(null)),
						);

					const shareUrl = verifiedCustomDomain
						? `${verifiedCustomDomain}/s/${videoId}`
						: canonicalShareUrl;

					if (buildEnv.NEXT_PUBLIC_IS_CAP && NODE_ENV === "production")
						yield* Effect.tryPromise(() =>
							dub().links.create({
								url: canonicalShareUrl,
								domain: "cap.link",
								key: videoId,
							}),
						).pipe(
							Effect.catchAll((error) =>
								Effect.logWarning(`Dub link create failed: ${String(error)}`),
							),
						);

					return {
						id: videoId,
						shareUrl,
						upload,
					};
				},
			),

			create: Effect.fn("Videos.create")(repo.create),

			getDownloadInfo: Effect.fn("Videos.getDownloadInfo")(function* (
				videoId: Video.VideoId,
			) {
				const maybeVideo = yield* policy.getViewableById(videoId);
				if (Option.isNone(maybeVideo))
					return yield* Effect.fail(new Video.NotFoundError());
				const [video] = maybeVideo.value;

				const [bucket] = yield* storage.getAccessForVideo(video);
				const [videoRow] = yield* db.use((db) =>
					db
						.select({ isScreenshot: Db.videos.isScreenshot })
						.from(Db.videos)
						.where(Dz.eq(Db.videos.id, videoId)),
				);

				if (videoRow?.isScreenshot) {
					const listResponse = yield* bucket.listObjects({
						prefix: `${video.ownerId}/${video.id}/`,
					});
					const screenshotKey = findScreenshotObjectKey(
						listResponse.Contents || [],
					);
					if (!screenshotKey) return Option.none();
					const extension = getFileExtensionFromKey(screenshotKey) ?? "jpg";
					const downloadUrl = yield* bucket.getSignedObjectUrl(screenshotKey);
					return Option.some({
						fileName: `${video.name}.${extension}`,
						downloadUrl,
					});
				}

				const src = Video.Video.getSource(video);

				if (src instanceof Video.Mp4Source && video.source.type === "webMP4") {
					const mp4Head = yield* bucket
						.headObject(src.getFileKey())
						.pipe(Effect.option);

					if (
						Option.isSome(mp4Head) &&
						(mp4Head.value.ContentLength ?? 0) > 0
					) {
						const downloadUrl = yield* bucket.getSignedObjectUrl(
							src.getFileKey(),
						);

						return Option.some({
							fileName: `${video.name}.mp4`,
							downloadUrl,
						});
					}

					const [upload] = yield* db.use((db) =>
						db
							.select({ rawFileKey: Db.videoUploads.rawFileKey })
							.from(Db.videoUploads)
							.where(Dz.eq(Db.videoUploads.videoId, video.id)),
					);

					if (upload?.rawFileKey) {
						const downloadUrl = yield* bucket.getSignedObjectUrl(
							upload.rawFileKey,
						);
						const extension =
							getFileExtensionFromKey(upload.rawFileKey) ?? "mp4";

						return Option.some({
							fileName: `${video.name}.${extension}`,
							downloadUrl,
						});
					}
				}

				if (!src) return Option.none();
				if (!(src instanceof Video.Mp4Source)) return Option.none();

				const downloadUrl = yield* bucket.getSignedObjectUrl(src.getFileKey());
				return Option.some({ fileName: `${video.name}.mp4`, downloadUrl });
			}),

			getThumbnailURL: Effect.fn("Videos.getThumbnailURL")(function* (
				videoId: Video.VideoId,
			) {
				const maybeVideo = yield* policy.getViewableById(videoId);
				if (Option.isNone(maybeVideo)) return Option.none();
				const [video] = maybeVideo.value;

				const [bucket] = yield* storage.getAccessForVideo(video);
				const publishedThumbnail = getPublishedRecordingThumbnailKey(video);
				if (publishedThumbnail) {
					return Option.some(
						yield* bucket.getSignedObjectUrl(publishedThumbnail),
					);
				}
				const listResponse = yield* bucket.listObjects({
					prefix: `${video.ownerId}/${video.id}/`,
				});
				const contents = listResponse.Contents || [];
				const thumbnailKey = findScreenshotObjectKey(contents);
				if (!thumbnailKey) return Option.none();
				const url = yield* bucket.getSignedObjectUrl(thumbnailKey);
				return Option.some(url);
			}),

			getAnalytics: Effect.fn("Videos.getAnalytics")(function* (
				videoId: Video.VideoId,
			) {
				const [result] = yield* getAnalyticsBulkInternal([videoId]);
				if (!result) return { count: 0 };
				return yield* Exit.matchEffect(result, {
					onSuccess: (value) => Effect.succeed(value),
					onFailure: (error) => Effect.fail(error),
				});
			}),
			getAnalyticsBulk: getAnalyticsBulkInternal,
			getAnalyticsBulkForOwner,
		};
	}),
	dependencies: [
		VideosPolicy.Default,
		VideosRepo.Default,
		Database.Default,
		StorageService.Default,
		Analytics.Default,
	],
}) {}
