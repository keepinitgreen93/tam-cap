import { isDeepStrictEqual } from "node:util";
import {
	requireOrganizationManager,
	requireOrganizationMember,
} from "@cap/database/cloudflare/access";
import { db } from "@cap/database/cloudflare/application";
import {
	type AtomicSnapshot,
	type AtomicStatement,
	atomic,
} from "@cap/database/cloudflare/atomic";
import * as Db from "@cap/database/cloudflare/schema";
import { Folder, Organisation, Space, User, Video } from "@cap/web-domain";
import { and, eq, isNull, not, or, sql } from "drizzle-orm";
import { FatalError } from "workflow";
import {
	CONTENT_TRANSFER_KIND,
	type ContentTransferPayload,
	type ContentTransferProgress,
	type ContentTransferUploadPhase,
	type ContentTransferVideoPlan,
	getContentTransferStorageBlockReason,
	isContentTransferProgress,
	MAX_CONTENT_TRANSFER_FOLDERS,
	MAX_CONTENT_TRANSFER_VIDEOS,
} from "@/lib/content-transfer";
import { decodeContentTransferPayload } from "@/lib/content-transfer-payload";
import { enqueueVideoStorageNameSync } from "@/lib/sync-video-storage-names";
import {
	loadVideoOwnershipTransfer,
	planVideoOwnershipTransfer,
	prepareVideoOwnershipTransfer,
	retainedOwnershipTransferMediaReason,
	type VideoOwnershipTransferState,
} from "@/lib/video-ownership-transfer";
import { inJsonArray } from "@/utils/sql";

const CONTENT_TRANSFER_UPLOAD_PHASES = new Set<ContentTransferUploadPhase>([
	"uploading",
	"processing",
	"generating_thumbnail",
	"complete",
	"error",
]);

function parsePayload(value: unknown): ContentTransferPayload {
	value = decodeContentTransferPayload(value);
	if (!value || typeof value !== "object") {
		throw new FatalError("Content transfer payload is invalid");
	}
	const payload = value as Partial<ContentTransferPayload>;
	if (
		payload.version !== 1 ||
		!payload.organizationId ||
		!payload.requestedByUserId ||
		!payload.targetUserId ||
		!payload.targetEmail ||
		!payload.sourceRootFolderId ||
		!payload.source ||
		!Array.isArray(payload.sourceFolderIds) ||
		!Array.isArray(payload.folderPlan) ||
		!Array.isArray(payload.videoPlan)
	) {
		throw new FatalError("Content transfer payload is incomplete");
	}
	if (
		(payload.source.type !== "organization" &&
			payload.source.type !== "space") ||
		(payload.source.type === "space" && !payload.source.spaceId)
	) {
		throw new FatalError("Content transfer source is invalid");
	}
	if (
		payload.sourceFolderIds.length === 0 ||
		payload.sourceFolderIds.length > MAX_CONTENT_TRANSFER_FOLDERS ||
		payload.folderPlan.length !== payload.sourceFolderIds.length ||
		payload.videoPlan.length > MAX_CONTENT_TRANSFER_VIDEOS
	) {
		throw new FatalError("Content transfer payload exceeds its bounds");
	}
	const sourceFolderIds = new Set(payload.sourceFolderIds);
	const destinationFolderIds = new Set<string>();
	for (const plan of payload.folderPlan) {
		if (
			!plan ||
			typeof plan !== "object" ||
			!plan.sourceFolderId ||
			!sourceFolderIds.has(plan.sourceFolderId) ||
			(plan.sourceParentId !== null &&
				typeof plan.sourceParentId !== "string") ||
			typeof plan.sourcePublic !== "boolean" ||
			!plan.destinationFolderId ||
			(plan.destinationParentId !== null &&
				typeof plan.destinationParentId !== "string") ||
			!plan.name ||
			!(["normal", "blue", "red", "yellow"] as const).includes(plan.color) ||
			typeof plan.create !== "boolean"
		) {
			throw new FatalError("Content transfer folder plan is invalid");
		}
		if (destinationFolderIds.has(plan.destinationFolderId)) {
			throw new FatalError("Content transfer destinations are not unique");
		}
		destinationFolderIds.add(plan.destinationFolderId);
	}
	if (
		!sourceFolderIds.has(payload.sourceRootFolderId) ||
		new Set(payload.folderPlan.map((plan) => plan.sourceFolderId)).size !==
			payload.sourceFolderIds.length
	) {
		throw new FatalError("Content transfer source folders are inconsistent");
	}
	const videoIds = new Set<string>();
	const membershipIds = new Set<string>();
	for (const item of payload.videoPlan) {
		if (
			!item ||
			typeof item !== "object" ||
			!item.videoId ||
			!item.name ||
			!item.sourceOwnerId ||
			!item.sourceMembershipId ||
			!sourceFolderIds.has(item.sourceFolderId) ||
			!destinationFolderIds.has(item.destinationFolderId) ||
			(item.sourceUploadPhase !== null &&
				!CONTENT_TRANSFER_UPLOAD_PHASES.has(item.sourceUploadPhase))
		) {
			throw new FatalError("Content transfer video plan is invalid");
		}
		if (
			videoIds.has(item.videoId) ||
			membershipIds.has(item.sourceMembershipId)
		) {
			throw new FatalError("Content transfer video plan contains duplicates");
		}
		videoIds.add(item.videoId);
		membershipIds.add(item.sourceMembershipId);
	}
	return payload as ContentTransferPayload;
}

function initialProgress(
	payload: ContentTransferPayload,
): ContentTransferProgress {
	return {
		phase: "queued",
		totalVideos: payload.videoPlan.length,
		processedVideos: 0,
		transferredVideos: 0,
		alreadyOwnedVideos: 0,
		copiedObjects: 0,
		currentVideoId: null,
		removedSourceFolder: false,
		cleanupWarnings: [],
	};
}

async function requireTransferAccess(
	snapshot: AtomicSnapshot,
	operationId: string,
	payload: ContentTransferPayload,
) {
	const [operation] = await snapshot.read((reader) =>
		reader
			.select()
			.from(Db.agentApiOperations)
			.where(eq(Db.agentApiOperations.id, operationId))
			.limit(1),
	);
	if (
		!operation ||
		operation.kind !== CONTENT_TRANSFER_KIND ||
		operation.resourceId !== payload.organizationId ||
		operation.userId !== payload.requestedByUserId ||
		operation.state !== "running" ||
		!isDeepStrictEqual(parsePayload(operation.payload), payload)
	)
		throw new FatalError("Content transfer operation is no longer active");
	await requireOrganizationManager(
		snapshot,
		Organisation.OrganisationId.make(payload.organizationId),
		User.UserId.make(payload.requestedByUserId),
	);
	await requireOrganizationMember(
		snapshot,
		Organisation.OrganisationId.make(payload.organizationId),
		User.UserId.make(payload.targetUserId),
	);
	return operation;
}

async function claimOperation(operationId: string) {
	"use step";
	const database = db(),
		now = new Date();
	return atomic(database, async (snapshot) => {
		const [operation] = await snapshot.read((reader) =>
			reader
				.select()
				.from(Db.agentApiOperations)
				.where(eq(Db.agentApiOperations.id, operationId))
				.limit(1),
		);
		if (!operation || operation.kind !== CONTENT_TRANSFER_KIND)
			throw new FatalError("Content transfer operation not found");
		if (operation.state !== "queued") return { statements: [], result: null };
		const payload = parsePayload(operation.payload);
		if (
			operation.resourceId !== payload.organizationId ||
			operation.userId !== payload.requestedByUserId
		)
			throw new FatalError("Content transfer operation scope is invalid");
		await requireOrganizationManager(
			snapshot,
			Organisation.OrganisationId.make(payload.organizationId),
			User.UserId.make(payload.requestedByUserId),
		);
		await requireOrganizationMember(
			snapshot,
			Organisation.OrganisationId.make(payload.organizationId),
			User.UserId.make(payload.targetUserId),
		);
		return {
			statements: [
				database
					.update(Db.agentApiOperations)
					.set({
						state: "running",
						result: initialProgress(payload),
						updatedAt: now,
					})
					.where(eq(Db.agentApiOperations.id, operationId)),
			],
			result: payload,
		};
	});
}

async function readSourceSnapshot(
	snapshot: AtomicSnapshot,
	payload: ContentTransferPayload,
) {
	const organizationId = Organisation.OrganisationId.make(
		payload.organizationId,
	);
	const sourceSpaceId =
		payload.source.type === "organization"
			? organizationId
			: Space.SpaceId.make(payload.source.spaceId);
	if (payload.source.type === "space") {
		const [space] = await snapshot.read((reader) =>
			reader
				.select({ id: Db.spaces.id })
				.from(Db.spaces)
				.where(
					and(
						eq(Db.spaces.id, sourceSpaceId),
						eq(Db.spaces.organizationId, organizationId),
					),
				)
				.limit(1),
		);
		if (!space) throw new FatalError("Source space no longer exists");
	}
	const currentFolders = await snapshot.read((reader) =>
		reader
			.select()
			.from(Db.folders)
			.where(
				and(
					inJsonArray(Db.folders.id, payload.sourceFolderIds),
					eq(Db.folders.organizationId, organizationId),
					eq(Db.folders.spaceId, sourceSpaceId),
				),
			),
	);
	if (currentFolders.length !== payload.folderPlan.length)
		throw new FatalError("Source folder hierarchy changed after review");
	const byId = new Map(
		currentFolders.map((folder) => [folder.id as string, folder]),
	);
	for (const plan of payload.folderPlan) {
		const current = byId.get(plan.sourceFolderId);
		if (
			!current ||
			current.name !== plan.name ||
			current.parentId !== plan.sourceParentId ||
			current.color !== plan.color ||
			current.public !== plan.sourcePublic
		)
			throw new FatalError("Source folder hierarchy changed after review");
	}
}

async function verifySourceSnapshot(
	operationId: string,
	payload: ContentTransferPayload,
) {
	"use step";
	const database = db();
	await atomic(database, async (snapshot) => {
		await requireTransferAccess(snapshot, operationId, payload);
		await readSourceSnapshot(snapshot, payload);
		return { statements: [], result: undefined };
	});
}

async function setOperationProgress(
	operationId: string,
	progress: ContentTransferProgress,
) {
	await db()
		.update(Db.agentApiOperations)
		.set({ result: progress, updatedAt: new Date() })
		.where(
			and(
				eq(Db.agentApiOperations.id, operationId),
				eq(Db.agentApiOperations.state, "running"),
			),
		);
}

async function createDestinationFolders(
	operationId: string,
	payload: ContentTransferPayload,
	progress: ContentTransferProgress,
) {
	"use step";
	const nextProgress = { ...progress, phase: "creating_folders" as const };
	const database = db(),
		now = Date.now();
	await atomic(database, async (snapshot) => {
		await requireTransferAccess(snapshot, operationId, payload);
		await readSourceSnapshot(snapshot, payload);
		const organizationId = Organisation.OrganisationId.make(
				payload.organizationId,
			),
			targetUserId = User.UserId.make(payload.targetUserId);
		const existing = await snapshot.read((reader) =>
			reader
				.select()
				.from(Db.folders)
				.where(
					or(
						inJsonArray(
							Db.folders.id,
							payload.folderPlan.map((plan) => plan.destinationFolderId),
						),
						and(
							eq(Db.folders.organizationId, organizationId),
							eq(Db.folders.createdById, targetUserId),
							isNull(Db.folders.spaceId),
						),
					),
				),
		);
		const byId = new Map(
			existing.map((folder) => [folder.id as string, folder]),
		);
		const names = new Map(
			existing
				.filter(
					(folder) =>
						folder.organizationId === organizationId &&
						folder.createdById === targetUserId &&
						folder.spaceId === null,
				)
				.map((folder) => [
					JSON.stringify([
						folder.parentId,
						folder.name.trim().toLocaleLowerCase(),
					]),
					folder.id as string,
				]),
		);
		const missing = [];
		for (const plan of payload.folderPlan) {
			const folder = byId.get(plan.destinationFolderId);
			if (folder) {
				if (
					folder.organizationId !== organizationId ||
					folder.createdById !== targetUserId ||
					folder.spaceId !== null ||
					folder.public ||
					folder.parentId !== plan.destinationParentId ||
					folder.name.trim().toLocaleLowerCase() !==
						plan.name.trim().toLocaleLowerCase()
				)
					throw new FatalError("A destination folder changed after review");
				continue;
			}
			if (!plan.create)
				throw new FatalError("A destination folder was removed after review");
			const key = JSON.stringify([
				plan.destinationParentId,
				plan.name.trim().toLocaleLowerCase(),
			]);
			if (names.has(key))
				throw new FatalError(
					"A matching destination folder was created after review",
				);
			names.set(key, plan.destinationFolderId);
			missing.push({
				id: plan.destinationFolderId,
				parentId: plan.destinationParentId,
				name: plan.name,
				color: plan.color,
			});
		}
		const projected = new Set([
			...byId.keys(),
			...missing.map((folder) => folder.id),
		]);
		if (
			missing.some(
				(folder) => folder.parentId && !projected.has(folder.parentId),
			)
		)
			throw new FatalError("A destination parent folder is missing");
		const statements: AtomicStatement[] = [];
		if (missing.length)
			statements.push(
				database
					.insert(Db.folders)
					.select(
						sql`select json_extract(value,'$.id'),json_extract(value,'$.name'),json_extract(value,'$.color'),0,null,${organizationId},${targetUserId},json_extract(value,'$.parentId'),null,${now},${now} from json_each(${JSON.stringify(missing)})`,
					),
			);
		statements.push(
			database
				.update(Db.agentApiOperations)
				.set({ result: nextProgress, updatedAt: new Date(now) })
				.where(eq(Db.agentApiOperations.id, operationId)),
		);
		return { statements, result: undefined };
	});
	return nextProgress;
}

async function readSourceMembership(
	snapshot: AtomicSnapshot,
	payload: ContentTransferPayload,
	item: ContentTransferVideoPlan,
) {
	const videoId = Video.VideoId.make(item.videoId);
	const sourceSpaceId =
		payload.source.type === "space"
			? Space.SpaceId.make(payload.source.spaceId)
			: Organisation.OrganisationId.make(payload.organizationId);
	return payload.source.type === "organization"
		? (
				await snapshot.read((reader) =>
					reader
						.select({
							id: Db.sharedVideos.id,
							folderId: Db.sharedVideos.folderId,
						})
						.from(Db.sharedVideos)
						.where(
							and(
								eq(Db.sharedVideos.id, item.sourceMembershipId),
								eq(Db.sharedVideos.videoId, videoId),
								eq(
									Db.sharedVideos.organizationId,
									Organisation.OrganisationId.make(payload.organizationId),
								),
							),
						)
						.limit(1),
				)
			)[0]
		: (
				await snapshot.read((reader) =>
					reader
						.select({
							id: Db.spaceVideos.id,
							folderId: Db.spaceVideos.folderId,
						})
						.from(Db.spaceVideos)
						.where(
							and(
								eq(Db.spaceVideos.id, item.sourceMembershipId),
								eq(Db.spaceVideos.videoId, videoId),
								eq(Db.spaceVideos.spaceId, sourceSpaceId),
							),
						)
						.limit(1),
				)
			)[0];
}

function assertTransferVideo(
	current: VideoOwnershipTransferState,
	payload: ContentTransferPayload,
	item: ContentTransferVideoPlan,
) {
	const video = current.video;
	if (
		video.orgId !== payload.organizationId ||
		(video.ownerId !== item.sourceOwnerId &&
			video.ownerId !== payload.targetUserId)
	)
		throw new FatalError(`Ownership changed for ${item.name}`);
	if (
		video.bucket !== item.bucketId ||
		video.storageIntegrationId !== item.storageIntegrationId ||
		(current.upload?.phase ?? null) !== item.sourceUploadPhase
	)
		throw new FatalError(`Storage changed for ${item.name}`);
	if (
		(current.upload && current.upload.phase !== "complete") ||
		video.source.type === "desktopSegments" ||
		video.transcriptionStatus === "PROCESSING" ||
		video.metadata?.editProcessing ||
		video.metadata?.aiGenerationStatus === "PROCESSING" ||
		(current.job &&
			["committing", "processing", "retry", "queued"].includes(
				current.job.state,
			)) ||
		current.job?.errorCode === "video-deleting"
	)
		throw new FatalError(`Cap ${item.name} is not ready to transfer`);
	if (
		(video.bucket && !current.bucketActive) ||
		(video.storageIntegrationId &&
			current.storageIntegrationStatus !== "active")
	)
		throw new FatalError(`Storage changed for ${item.name}`);
	const reason = getContentTransferStorageBlockReason({
		sourceOwnerId: video.ownerId,
		targetUserId: payload.targetUserId,
		organizationId: payload.organizationId,
		bucketId: video.bucket,
		bucketOwnerId: current.bucketOwnerId,
		bucketOrganizationId: current.bucketOrganizationId,
		storageIntegrationId: video.storageIntegrationId,
		storageIntegrationOwnerId: current.storageIntegrationOwnerId,
		storageIntegrationOrganizationId: current.storageIntegrationOrganizationId,
	});
	if (reason) throw new FatalError(reason);
}

async function transferOneVideo(
	operationId: string,
	payload: ContentTransferPayload,
	item: ContentTransferVideoPlan,
	progress: ContentTransferProgress,
) {
	"use step";
	const database = db(),
		targetUserId = User.UserId.make(payload.targetUserId),
		videoId = Video.VideoId.make(item.videoId),
		destinationFolderId = Folder.FolderId.make(item.destinationFolderId);
	const loaded = await atomic(database, async (snapshot) => {
		const operation = await requireTransferAccess(
			snapshot,
			operationId,
			payload,
		);
		const current = await loadVideoOwnershipTransfer(snapshot, videoId);
		const membership = await readSourceMembership(snapshot, payload, item);
		const saved = operation.result;
		if (
			isContentTransferProgress(saved) &&
			saved.processedVideos > progress.processedVideos &&
			current.video.ownerId === targetUserId &&
			current.video.folderId === destinationFolderId &&
			!membership
		)
			return { statements: [], result: { current, replayed: saved } };
		assertTransferVideo(current, payload, item);
		if (!membership || membership.folderId !== item.sourceFolderId)
			throw new FatalError(`Source placement changed for ${item.name}`);
		return { statements: [], result: { current, replayed: null } };
	});
	if (loaded.replayed) return loaded.replayed;
	const prepared = await prepareVideoOwnershipTransfer(
		loaded.current,
		targetUserId,
	);
	const ownerChanged = loaded.current.video.ownerId !== targetUserId;
	const nextProgress: ContentTransferProgress = {
		...progress,
		phase: "transferring",
		processedVideos: progress.processedVideos + 1,
		transferredVideos: progress.transferredVideos + (ownerChanged ? 1 : 0),
		alreadyOwnedVideos: progress.alreadyOwnedVideos + (ownerChanged ? 0 : 1),
		copiedObjects: progress.copiedObjects + prepared.copiedObjects,
		currentVideoId: item.videoId,
		cleanupWarnings:
			prepared.copied &&
			!progress.cleanupWarnings.includes(retainedOwnershipTransferMediaReason)
				? [...progress.cleanupWarnings, retainedOwnershipTransferMediaReason]
				: progress.cleanupWarnings,
	};
	const now = new Date();
	try {
		await atomic(database, async (snapshot) => {
			await requireTransferAccess(snapshot, operationId, payload);
			const membership = await readSourceMembership(snapshot, payload, item);
			if (!membership || membership.folderId !== item.sourceFolderId)
				throw new FatalError(`Source placement changed for ${item.name}`);
			const statements = await planVideoOwnershipTransfer(
				snapshot,
				database,
				prepared,
				{
					organizationId: Organisation.OrganisationId.make(
						payload.organizationId,
					),
					folderId: destinationFolderId,
					now,
				},
			);
			statements.push(
				payload.source.type === "organization"
					? database
							.delete(Db.sharedVideos)
							.where(eq(Db.sharedVideos.id, item.sourceMembershipId))
					: database
							.delete(Db.spaceVideos)
							.where(eq(Db.spaceVideos.id, item.sourceMembershipId)),
				database
					.update(Db.agentApiOperations)
					.set({ result: nextProgress, updatedAt: now })
					.where(eq(Db.agentApiOperations.id, operationId)),
			);
			return { statements, result: undefined };
		});
	} catch (error) {
		const confirmed = await atomic(database, async (snapshot) => {
			const operation = await requireTransferAccess(
				snapshot,
				operationId,
				payload,
			);
			const [video] = await snapshot.read((reader) =>
				reader
					.select()
					.from(Db.videos)
					.where(eq(Db.videos.id, videoId))
					.limit(1),
			);
			const membership = await readSourceMembership(snapshot, payload, item);
			return {
				statements: [],
				result: Boolean(
					video?.ownerId === targetUserId &&
						video.folderId === destinationFolderId &&
						!membership &&
						isContentTransferProgress(operation.result) &&
						operation.result.processedVideos >= nextProgress.processedVideos,
				),
			};
		});
		if (!confirmed) throw error;
	}
	await enqueueVideoStorageNameSync(videoId);
	return nextProgress;
}

async function cleanupSourceFolders(
	operationId: string,
	payload: ContentTransferPayload,
	progress: ContentTransferProgress,
) {
	"use step";
	const database = db();
	const warning = await atomic<string | null>(database, async (snapshot) => {
		await requireTransferAccess(snapshot, operationId, payload);
		const organizationId = Organisation.OrganisationId.make(
				payload.organizationId,
			),
			ids = payload.sourceFolderIds,
			sourceSpaceId =
				payload.source.type === "organization"
					? organizationId
					: Space.SpaceId.make(payload.source.spaceId);
		const folders = await snapshot.read((reader) =>
			reader
				.select()
				.from(Db.folders)
				.where(
					and(
						inJsonArray(Db.folders.id, ids),
						eq(Db.folders.organizationId, organizationId),
						eq(Db.folders.spaceId, sourceSpaceId),
					),
				),
		);
		const byId = new Map(
			folders.map((folder) => [folder.id as string, folder]),
		);
		if (
			folders.length !== ids.length ||
			payload.folderPlan.some((plan) => {
				const folder = byId.get(plan.sourceFolderId);
				return (
					!folder ||
					folder.name !== plan.name ||
					folder.parentId !== plan.sourceParentId ||
					folder.public !== plan.sourcePublic
				);
			})
		)
			return {
				statements: [],
				result: "Source folders changed during the transfer",
			};
		const [
			[organizationPlacement],
			[spacePlacement],
			[personalPlacement],
			[newChild],
		] = await Promise.all([
			snapshot.read((reader) =>
				reader
					.select({ id: Db.sharedVideos.id })
					.from(Db.sharedVideos)
					.where(inJsonArray(Db.sharedVideos.folderId, ids))
					.limit(1),
			),
			snapshot.read((reader) =>
				reader
					.select({ id: Db.spaceVideos.id })
					.from(Db.spaceVideos)
					.where(inJsonArray(Db.spaceVideos.folderId, ids))
					.limit(1),
			),
			snapshot.read((reader) =>
				reader
					.select({ id: Db.videos.id })
					.from(Db.videos)
					.where(inJsonArray(Db.videos.folderId, ids))
					.limit(1),
			),
			snapshot.read((reader) =>
				reader
					.select({ id: Db.folders.id })
					.from(Db.folders)
					.where(
						and(
							inJsonArray(Db.folders.parentId, ids),
							not(inJsonArray(Db.folders.id, ids)),
						),
					)
					.limit(1),
			),
		]);
		if (
			organizationPlacement ||
			spacePlacement ||
			personalPlacement ||
			newChild
		)
			return {
				statements: [],
				result: "Source folders were kept because they received new content",
			};
		return {
			statements: [
				database
					.delete(Db.folders)
					.where(
						and(
							inJsonArray(Db.folders.id, ids),
							eq(Db.folders.organizationId, organizationId),
							eq(Db.folders.spaceId, sourceSpaceId),
						),
					),
			],
			result: null,
		};
	});
	const completed: ContentTransferProgress = {
		...progress,
		phase: "cleaning_up",
		currentVideoId: null,
		removedSourceFolder: warning === null,
		cleanupWarnings: warning
			? [...progress.cleanupWarnings, warning]
			: progress.cleanupWarnings,
	};
	await setOperationProgress(operationId, completed);
	return completed;
}

async function completeOperation(
	operationId: string,
	progress: ContentTransferProgress,
) {
	"use step";
	const database = db(),
		now = new Date(),
		result = { ...progress, currentVideoId: null };
	try {
		const changed = await database
			.update(Db.agentApiOperations)
			.set({
				state: "succeeded",
				result,
				completedAt: now,
				updatedAt: now,
				errorCode: null,
				errorMessage: null,
			})
			.where(
				and(
					eq(Db.agentApiOperations.id, operationId),
					eq(Db.agentApiOperations.kind, CONTENT_TRANSFER_KIND),
					eq(Db.agentApiOperations.state, "running"),
				),
			);
		if (changed.meta.changes !== 1)
			throw Error("Content transfer operation is no longer active");
	} catch (error) {
		const [operation] = await database
			.select()
			.from(Db.agentApiOperations)
			.where(
				and(
					eq(Db.agentApiOperations.id, operationId),
					eq(Db.agentApiOperations.kind, CONTENT_TRANSFER_KIND),
				),
			)
			.limit(1);
		if (
			operation?.state !== "succeeded" ||
			!isDeepStrictEqual(operation.result, result)
		)
			throw error;
	}
}

async function failOperation(operationId: string, error: unknown) {
	"use step";
	const now = new Date();
	await db()
		.update(Db.agentApiOperations)
		.set({
			state: "failed",
			errorCode: "CONTENT_TRANSFER_FAILED",
			errorMessage:
				error instanceof Error ? error.message : "Content transfer failed",
			completedAt: now,
			updatedAt: now,
		})
		.where(
			and(
				eq(Db.agentApiOperations.id, operationId),
				eq(Db.agentApiOperations.kind, CONTENT_TRANSFER_KIND),
				inJsonArray(Db.agentApiOperations.state, ["queued", "running"]),
			),
		);
}

export async function transferOrganizationContentWorkflow(input: {
	operationId: string;
}) {
	"use workflow";

	try {
		const payload = await claimOperation(input.operationId);
		if (!payload) return;
		let progress = initialProgress(payload);
		await verifySourceSnapshot(input.operationId, payload);
		progress = await createDestinationFolders(
			input.operationId,
			payload,
			progress,
		);
		for (const item of payload.videoPlan) {
			progress = await transferOneVideo(
				input.operationId,
				payload,
				item,
				progress,
			);
		}
		progress = await cleanupSourceFolders(input.operationId, payload, progress);
		await completeOperation(input.operationId, progress);
	} catch (error) {
		await failOperation(input.operationId, error);
		throw error;
	}
}
