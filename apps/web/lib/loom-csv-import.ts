import "server-only";

import { normalizeEmail } from "@cap/database/auth/identity";
import type { CloudflareDatabase } from "@cap/database/cloudflare";
import {
	requireActiveOrganization,
	requireOrganizationManager,
	requireOrganizationMember,
} from "@cap/database/cloudflare/access";
import { db } from "@cap/database/cloudflare/application";
import { type AtomicSnapshot, atomic } from "@cap/database/cloudflare/atomic";
import {
	folders,
	importedVideos,
	loomMigrationImports,
	loomMigrationRequests,
	organizationMembers,
	organizations,
	sharedVideos,
	spaceMembers,
	spaces,
	spaceVideos,
	users,
	videos,
	videoUploads,
} from "@cap/database/cloudflare/schema";
import { nanoId } from "@cap/database/helpers";
import { buildEnv, NODE_ENV, serverEnv } from "@cap/env";
import { dub } from "@cap/utils";
import { Storage } from "@cap/web-backend";
import {
	Folder,
	type Organisation,
	Space,
	SpaceMemberId,
	type User,
	Video,
} from "@cap/web-domain";
import { and, asc, eq, isNull, notExists, sql } from "drizzle-orm";
import { Option } from "effect";
import { revalidatePath } from "next/cache";
import {
	assertMigrationOperator,
	renewConciergeImport,
} from "@/lib/loom-concierge";
import {
	getLoomDownloadUrl,
	LoomDownloadTemporaryError,
} from "@/lib/loom-download-url";
import type { LoomImportDestination } from "@/lib/loom-import-destination";
import {
	getLoomImportRunState,
	LOOM_IMPORT_CONFIRMATION_MESSAGE,
	LoomImportStartError,
	restoreLoomImportStartError,
	startLoomImportWorkflow,
} from "@/lib/loom-import-start";
import { LoomMigrationError } from "@/lib/loom-migration-state";
import { provisionOrganizationInvitee } from "@/lib/organization-provisioning";
import { runPromise } from "@/lib/server";

export type LoomDownloadMode = "direct-download" | "browser-conversion";

export interface LoomDownloadResult {
	success: boolean;
	videoId?: string;
	videoName?: string;
	downloadUrl?: string;
	downloadMode?: LoomDownloadMode;
	durationSeconds?: number;
	width?: number;
	height?: number;
	requiresProxy?: boolean;
	error?: string;
}

export type LoomImportErrorCode = "loom_temporarily_unavailable";

export interface LoomImportResult {
	success: boolean;
	videoId?: Video.VideoId;
	error?: string;
	errorCode?: LoomImportErrorCode;
}

export interface LoomCsvImportRow {
	rowNumber: number;
	loomUrl: string;
	userEmail: string;
	spaceName?: string;
	folderName?: string;
}

export interface LoomCsvImportRowResult {
	rowNumber: number;
	userEmail: string;
	spaceName?: string;
	success: boolean;
	videoId?: Video.VideoId;
	error?: string;
	errorCode?: LoomImportErrorCode;
}

export interface LoomCsvImportResult {
	success: boolean;
	importedCount: number;
	failedCount: number;
	results: LoomCsvImportRowResult[];
	error?: string;
}

export const MAX_LOOM_CSV_ROWS = 500;
export const MAX_LOOM_SPACE_NAME_LENGTH = 255;
export const MAX_LOOM_VIDEO_NAME_LENGTH = 255;
export const LOOM_CSV_LIMIT_ERROR = `CSV imports are limited to ${MAX_LOOM_CSV_ROWS} rows at a time. Contact support to raise this limit.`;
export const LOOM_CSV_PERMISSION_ERROR =
	"Only organization admins and owners can import Loom videos from a CSV.";
export const LOOM_VIDEO_ID_PATTERN = /^[A-Za-z0-9_-]{10,64}$/;

export function extractLoomVideoId(url: string): string | null {
	try {
		const parsed = new URL(url);
		if (
			parsed.protocol !== "https:" ||
			(parsed.hostname !== "loom.com" && !parsed.hostname.endsWith(".loom.com"))
		) {
			return null;
		}

		const pathParts = parsed.pathname.split("/").filter(Boolean);
		const id = pathParts[pathParts.length - 1] ?? null;

		if (!id || !LOOM_VIDEO_ID_PATTERN.test(id)) {
			return null;
		}

		return id;
	} catch {
		return null;
	}
}

export async function fetchVideoName(videoId: string): Promise<string | null> {
	try {
		const response = await fetch("https://www.loom.com/graphql", {
			method: "POST",
			headers: {
				"Content-Type": "application/json",
				Accept: "application/json",
				"x-loom-request-source": "loom_web",
			},
			body: JSON.stringify({
				operationName: "GetVideoName",
				variables: { videoId, password: null },
				query: `query GetVideoName($videoId: ID!, $password: String) {
					getVideo(id: $videoId, password: $password) {
						... on RegularUserVideo { name }
						... on PrivateVideo { id }
						... on VideoPasswordMissingOrIncorrect { id }
					}
				}`,
			}),
		});

		if (!response.ok) return null;

		const data = await response.json();
		return data?.data?.getVideo?.name ?? null;
	} catch {
		return null;
	}
}

export function isDirectMp4Url(url: string): boolean {
	const path = (url.split("?")[0] ?? "").toLowerCase();
	return path.endsWith(".mp4");
}

export async function fetchLoomOEmbed(
	loomVideoId: string,
): Promise<{ duration?: number; width?: number; height?: number } | null> {
	try {
		const response = await fetch(
			`https://www.loom.com/v1/oembed?url=${encodeURIComponent(`https://www.loom.com/share/${loomVideoId}`)}`,
			{ headers: { Accept: "application/json" } },
		);
		if (!response.ok) return null;
		const data = await response.json();
		return {
			duration: data.duration ? Math.round(data.duration) : undefined,
			width: data.width ?? undefined,
			height: data.height ?? undefined,
		};
	} catch {
		return null;
	}
}

export async function assertConciergeLease(
	snapshot: AtomicSnapshot,
	requestId: string,
	leaseToken: string | undefined,
	organizationId?: Organisation.OrganisationId,
) {
	const [reservation] = await snapshot.read((reader) =>
		reader
			.select()
			.from(loomMigrationRequests)
			.where(eq(loomMigrationRequests.id, requestId))
			.limit(1),
	);
	if (
		!leaseToken ||
		!reservation ||
		reservation.activeOrganizationId !== reservation.organizationId ||
		(organizationId && reservation.organizationId !== organizationId) ||
		reservation.activeImportLeaseToken !== leaseToken ||
		!reservation.activeImportLeaseUntil ||
		reservation.activeImportLeaseUntil <= new Date() ||
		!reservation.lastOperatorUserId
	)
		throw new LoomMigrationError(
			"The concierge import expired. Retry this video.",
		);
	await assertMigrationOperator(snapshot, reservation.lastOperatorUserId);
	await requireActiveOrganization(snapshot, reservation.organizationId);
	return reservation;
}

export function conciergeImportStatements(
	database: CloudflareDatabase,
	videoId: Video.VideoId,
	requestId: string,
) {
	return [
		database.insert(loomMigrationImports).values({ videoId, requestId }),
		database
			.update(loomMigrationRequests)
			.set({
				queuedVideoCount: sql`${loomMigrationRequests.queuedVideoCount} + 1`,
				updatedAt: new Date(),
			})
			.where(eq(loomMigrationRequests.id, requestId)),
	];
}

export async function assertLoomImportDestination(
	snapshot: AtomicSnapshot,
	orgId: Organisation.OrganisationId,
	ownerId: User.UserId,
	destination: LoomImportDestination,
	actorId: User.UserId = ownerId,
) {
	const access = await requireOrganizationMember(snapshot, orgId, ownerId);
	if (actorId !== ownerId)
		await requireOrganizationManager(snapshot, orgId, actorId);
	if (destination.spaceId === orgId)
		await requireOrganizationManager(snapshot, orgId, actorId);
	else if (destination.spaceId) {
		const [space] = await snapshot.read((reader) =>
			reader
				.select()
				.from(spaces)
				.where(eq(spaces.id, destination.spaceId as Space.SpaceId))
				.limit(1),
		);
		if (!space || space.organizationId !== orgId)
			throw new Error("Space not found");
		const actorAccess =
			actorId === ownerId
				? access
				: await requireOrganizationMember(snapshot, orgId, actorId);
		const [membership] = await snapshot.read((reader) =>
			reader
				.select()
				.from(spaceMembers)
				.where(
					and(
						eq(spaceMembers.spaceId, space.id),
						eq(spaceMembers.userId, actorId),
					),
				)
				.limit(1),
		);
		if (
			actorAccess.role === "member" &&
			space.createdById !== actorId &&
			membership?.role !== "admin"
		)
			throw new Error("Space management is required");
	}
	if (destination.folderId) {
		const [folder] = await snapshot.read((reader) =>
			reader
				.select()
				.from(folders)
				.where(eq(folders.id, destination.folderId as Folder.FolderId))
				.limit(1),
		);
		if (
			!folder ||
			folder.organizationId !== orgId ||
			(destination.spaceId
				? folder.spaceId !== destination.spaceId
				: folder.spaceId !== null || folder.createdById !== ownerId)
		)
			throw new Error("Folder not found");
	}
	return access.organization;
}

export async function importLoomVideoForOwner({
	loomUrl,
	orgId,
	ownerId,
	destination = {},
	migrationRequestId,
	migrationLeaseToken,
	importPriority,
	actorId = ownerId,
}: {
	loomUrl: string;
	orgId: Organisation.OrganisationId;
	ownerId: User.UserId;
	actorId?: User.UserId;
	destination?: LoomImportDestination;
	migrationRequestId?: string;
	migrationLeaseToken?: string;
	importPriority?: "customer" | "bulk";
}): Promise<LoomImportResult> {
	const loomVideoId = extractLoomVideoId(loomUrl.trim());
	if (!loomVideoId) {
		return {
			success: false,
			error:
				"Invalid Loom URL. Please paste a valid Loom video link (e.g. https://www.loom.com/share/abc123).",
		};
	}

	const existing = await db()
		.select({
			videoId: videos.id,
			ownerId: videos.ownerId,
			bucketId: videos.bucket,
			metadata: videos.metadata,
			phase: videoUploads.phase,
			rawFileKey: videoUploads.rawFileKey,
			uploadUpdatedAt: videoUploads.updatedAt,
		})
		.from(importedVideos)
		.leftJoin(
			videos,
			and(
				eq(videos.id, importedVideos.id),
				eq(videos.orgId, importedVideos.orgId),
			),
		)
		.leftJoin(videoUploads, eq(videoUploads.videoId, videos.id))
		.where(
			and(
				eq(importedVideos.orgId, orgId),
				eq(importedVideos.source, "loom"),
				eq(importedVideos.sourceId, loomVideoId),
			),
		);

	const existingVideo = existing.find((row) => row.videoId !== null);
	if (existingVideo?.videoId) {
		if (
			existingVideo.phase === "error" &&
			existingVideo.ownerId === ownerId &&
			existingVideo.uploadUpdatedAt
		) {
			const runState = await getLoomImportRunState(
				existingVideo.metadata?.loomImportRun,
			);
			if (runState === "unconfirmed") {
				return { success: false, error: LOOM_IMPORT_CONFIRMATION_MESSAGE };
			}
			if (runState !== "inactive") {
				return {
					success: false,
					error: "This Loom import is already restarting.",
				};
			}
			const rawFileKey =
				existingVideo.rawFileKey ??
				`${ownerId}/${existingVideo.videoId}/raw-upload.mp4`;
			const failedVideoId = existingVideo.videoId;
			const failedUpdatedAt = existingVideo.uploadUpdatedAt;
			const claimedAt = new Date(Math.floor(Date.now() / 1000) * 1000);
			const database = db();
			const claimOutcome = await atomic(database, async (snapshot) => {
				await assertLoomImportDestination(
					snapshot,
					orgId,
					ownerId,
					destination,
					actorId,
				);
				let mappedRequestId: string | undefined;
				if (migrationRequestId) {
					await assertConciergeLease(
						snapshot,
						migrationRequestId,
						migrationLeaseToken,
						orgId,
					);
					const [mapped] = await snapshot.read((reader) =>
						reader
							.select({ requestId: loomMigrationImports.requestId })
							.from(loomMigrationImports)
							.where(eq(loomMigrationImports.videoId, failedVideoId))
							.limit(1),
					);
					mappedRequestId = mapped?.requestId;
					if (mappedRequestId && mappedRequestId !== migrationRequestId)
						return { statements: [], result: "foreign" as const };
				}
				const [current] = await snapshot.read((reader) =>
					reader
						.select({ video: videos, upload: videoUploads })
						.from(videos)
						.innerJoin(videoUploads, eq(videoUploads.videoId, videos.id))
						.where(eq(videos.id, failedVideoId))
						.limit(1),
				);
				if (
					!current ||
					current.video.ownerId !== ownerId ||
					current.video.orgId !== orgId ||
					current.upload.phase !== "error" ||
					current.upload.updatedAt.getTime() !== failedUpdatedAt.getTime() ||
					JSON.stringify(current.video.metadata?.loomImportRun) !==
						JSON.stringify(existingVideo.metadata?.loomImportRun)
				)
					return { statements: [], result: "busy" as const };
				return {
					statements: [
						database
							.update(videoUploads)
							.set({
								phase: "processing",
								processingProgress: 0,
								processingMessage: "Restarting Loom import...",
								processingError: null,
								rawFileKey,
								updatedAt: claimedAt,
							})
							.where(eq(videoUploads.videoId, failedVideoId)),
						...(migrationRequestId && !mappedRequestId
							? conciergeImportStatements(
									database,
									failedVideoId,
									migrationRequestId,
								)
							: []),
					],
					result: "claimed" as const,
				};
			});
			if (claimOutcome === "foreign") {
				return {
					success: false,
					error: "This Loom import belongs to another migration request.",
				};
			}
			if (claimOutcome === "busy") {
				return {
					success: false,
					error: "This Loom import is already restarting.",
				};
			}
			try {
				await startLoomImportWorkflow({
					videoId: existingVideo.videoId,
					userId: ownerId,
					rawFileKey,
					bucketId: existingVideo.bucketId,
					loomVideoId,
					reuseExistingRawUpload: true,
					importPriority,
				});
			} catch (error) {
				if (error instanceof LoomImportStartError && error.canRetry) {
					await restoreLoomImportStartError(
						existingVideo.videoId,
						"processing",
						claimedAt,
						error.message,
					);
				}
				return {
					success: false,
					error:
						error instanceof Error
							? error.message
							: "Loom import could not restart.",
				};
			}
			revalidatePath("/dashboard/caps");
			return { success: true, videoId: existingVideo.videoId };
		}
		return {
			success: false,
			error: "This Loom video has already been imported.",
		};
	}

	let downloadUrl: string | null;
	try {
		downloadUrl = await getLoomDownloadUrl(loomVideoId);
	} catch (error) {
		if (error instanceof LoomDownloadTemporaryError) {
			return {
				success: false,
				error: error.message,
				errorCode: "loom_temporarily_unavailable",
			};
		}
		throw error;
	}
	if (!downloadUrl) {
		return {
			success: false,
			error:
				"Could not retrieve a download URL. The video may be private, password-protected, or the link may have expired.",
		};
	}

	const [videoName, oembedMeta] = await Promise.all([
		fetchVideoName(loomVideoId),
		fetchLoomOEmbed(loomVideoId),
	]);

	const writableResult = await Storage.getWritableAccessForUser(ownerId, orgId)
		.pipe(runPromise)
		.then(
			(value) => ({ ok: true as const, value }),
			(error) => ({ ok: false as const, error }),
		);

	if (!writableResult.ok) {
		console.error(
			`Loom import: failed to resolve storage access for user ${ownerId} in org ${orgId}:`,
			writableResult.error,
		);
		return {
			success: false,
			error:
				"Could not prepare storage for this import. Please try again or contact support.",
		};
	}

	const writable = writableResult.value;

	const videoId = Video.VideoId.make(nanoId());
	const name = Array.from(
		videoName ||
			`Loom Import - ${new Date().toLocaleDateString("en-US", { day: "numeric", month: "long", year: "numeric" })}`,
	)
		.slice(0, MAX_LOOM_VIDEO_NAME_LENGTH)
		.join("");

	const claimedAt = new Date(Math.floor(Date.now() / 1000) * 1000);
	const database = db();
	await atomic(database, async (snapshot) => {
		const organization = await assertLoomImportDestination(
			snapshot,
			orgId,
			ownerId,
			destination,
			actorId,
		);
		if (migrationRequestId)
			await assertConciergeLease(
				snapshot,
				migrationRequestId,
				migrationLeaseToken,
				orgId,
			);
		const prior = await snapshot.read((reader) =>
			reader
				.select({ id: importedVideos.id, liveId: videos.id })
				.from(importedVideos)
				.leftJoin(videos, eq(videos.id, importedVideos.id))
				.where(
					and(
						eq(importedVideos.orgId, orgId),
						eq(importedVideos.source, "loom"),
						eq(importedVideos.sourceId, loomVideoId),
					),
				),
		);
		if (prior.some((row) => row.liveId !== null))
			throw new Error("This Loom video has already been imported.");
		const statements = [
			...(prior.length
				? [
						database
							.delete(importedVideos)
							.where(
								and(
									eq(importedVideos.orgId, orgId),
									eq(importedVideos.source, "loom"),
									eq(importedVideos.sourceId, loomVideoId),
									notExists(
										database
											.select({ id: videos.id })
											.from(videos)
											.where(eq(videos.id, importedVideos.id)),
									),
								),
							),
					]
				: []),
			database.insert(videos).values({
				id: videoId,
				name,
				ownerId,
				orgId,
				folderId: destination.spaceId ? undefined : destination.folderId,
				source: { type: "webMP4" as const },
				bucket: Option.getOrNull(writable.bucketId),
				storageIntegrationId: Option.getOrNull(writable.storageIntegrationId),
				public:
					organization.defaultVideoVisibility !== "private" &&
					serverEnv().CAP_VIDEOS_DEFAULT_PUBLIC,
				...(oembedMeta?.duration ? { duration: oembedMeta.duration } : {}),
				...(oembedMeta?.width ? { width: oembedMeta.width } : {}),
				...(oembedMeta?.height ? { height: oembedMeta.height } : {}),
			}),
			database.insert(videoUploads).values({
				videoId,
				phase: "uploading",
				processingProgress: 0,
				processingMessage: "Importing from Loom...",
				updatedAt: claimedAt,
			}),
			database
				.insert(importedVideos)
				.values({ id: videoId, orgId, source: "loom", sourceId: loomVideoId }),
			...(migrationRequestId
				? conciergeImportStatements(database, videoId, migrationRequestId)
				: []),
			...(destination.spaceId === orgId
				? [
						database.insert(sharedVideos).values({
							id: nanoId(),
							videoId,
							organizationId: orgId,
							sharedByUserId: ownerId,
							folderId: destination.folderId,
						}),
					]
				: destination.spaceId
					? [
							database.insert(spaceVideos).values({
								id: nanoId(),
								videoId,
								spaceId: destination.spaceId,
								addedById: actorId,
								folderId: destination.folderId,
							}),
						]
					: []),
		];
		return { statements, result: undefined };
	});

	const rawFileKey = `${ownerId}/${videoId}/raw-upload.mp4`;

	if (
		process.env.CAP_RUNTIME !== "cloudflare" &&
		buildEnv.NEXT_PUBLIC_IS_CAP === "true" &&
		NODE_ENV === "production"
	) {
		await dub()
			.links.create({
				url: `${serverEnv().WEB_URL}/s/${videoId}`,
				domain: "cap.link",
				key: videoId,
			})
			.catch(() => {});
	}

	try {
		await startLoomImportWorkflow({
			videoId,
			userId: ownerId,
			rawFileKey,
			bucketId: Option.getOrNull(writable.bucketId),
			loomVideoId,
			loomDownloadUrl: downloadUrl,
			importPriority,
		});
	} catch (error) {
		if (error instanceof LoomImportStartError && error.canRetry) {
			await restoreLoomImportStartError(
				videoId,
				"uploading",
				claimedAt,
				error.message,
			);
		}
		return {
			success: false,
			videoId,
			error:
				error instanceof Error ? error.message : "Loom import could not start.",
		};
	}

	revalidatePath("/dashboard/caps");
	if (destination.folderId) revalidatePath("/dashboard/folder/[id]", "page");
	if (destination.spaceId) {
		revalidatePath("/dashboard/spaces/[spaceId]", "page");
		revalidatePath("/dashboard/spaces/[spaceId]/folder/[folderId]", "page");
	}

	return { success: true, videoId };
}

export function normalizeImportEmail(email: string) {
	try {
		return normalizeEmail(email);
	} catch {
		return email.trim().toLowerCase();
	}
}

export function normalizeImportSpaceName(spaceName: string) {
	return spaceName.trim().replace(/\s+/g, " ");
}

export function getSpaceNameCacheKey(spaceName: string) {
	return normalizeImportSpaceName(spaceName).toLowerCase();
}

export function isValidImportEmail(email: string) {
	try {
		normalizeEmail(email);
		return true;
	} catch {
		return false;
	}
}

export function isValidImportSpaceName(spaceName: string) {
	return spaceName.length <= MAX_LOOM_SPACE_NAME_LENGTH;
}

export async function getOrganizationMemberByEmail(
	orgId: Organisation.OrganisationId,
	email: string,
) {
	const [member] = await db()
		.select({
			userId: organizationMembers.userId,
			email: users.email,
		})
		.from(organizationMembers)
		.innerJoin(users, eq(organizationMembers.userId, users.id))
		.innerJoin(
			organizations,
			eq(organizations.id, organizationMembers.organizationId),
		)
		.where(
			and(
				eq(organizationMembers.organizationId, orgId),
				isNull(organizations.tombstoneAt),
				eq(users.email, normalizeImportEmail(email)),
			),
		)
		.limit(1);

	return member ?? null;
}

export type ImportSpaceCacheValue = {
	id: Space.SpaceIdOrOrganisationId;
	name: string;
};

export async function getOrCreateImportSpace({
	orgId,
	createdById,
	name,
	spaceCache,
}: {
	orgId: Organisation.OrganisationId;
	createdById: User.UserId;
	name: string;
	spaceCache: Map<string, ImportSpaceCacheValue>;
}) {
	const normalizedName = normalizeImportSpaceName(name);
	const cacheKey = getSpaceNameCacheKey(normalizedName);
	const cached = spaceCache.get(cacheKey);
	if (cached) return cached;

	const spaceId = Space.SpaceId.make(nanoId());
	const memberId = SpaceMemberId.make(nanoId());
	const database = db();
	const value = await atomic(database, async (snapshot) => {
		await requireOrganizationManager(snapshot, orgId, createdById);
		const candidates = await snapshot.read((reader) =>
			reader
				.select({ id: spaces.id, name: spaces.name })
				.from(spaces)
				.where(eq(spaces.organizationId, orgId)),
		);
		const existing = candidates.find(
			(candidate) => getSpaceNameCacheKey(candidate.name) === cacheKey,
		);
		if (existing) return { statements: [], result: existing };
		return {
			statements: [
				database.insert(spaces).values({
					id: spaceId,
					name: normalizedName,
					organizationId: orgId,
					createdById,
					iconUrl: null,
				}),
				database.insert(spaceMembers).values({
					id: memberId,
					spaceId,
					userId: createdById,
					role: "admin",
				}),
			],
			result: { id: spaceId, name: normalizedName },
		};
	});
	spaceCache.set(cacheKey, value);
	return value;
}

export async function addImportedVideoToSpace({
	videoId,
	spaceId,
	addedById,
}: {
	videoId: Video.VideoId;
	spaceId: Space.SpaceIdOrOrganisationId;
	addedById: User.UserId;
}) {
	const database = db();
	const id = nanoId();
	await atomic(database, async (snapshot) => {
		const [space] = await snapshot.read((reader) =>
			reader
				.select()
				.from(spaces)
				.where(eq(spaces.id, spaceId as Space.SpaceId))
				.limit(1),
		);
		const [video] = await snapshot.read((reader) =>
			reader.select().from(videos).where(eq(videos.id, videoId)).limit(1),
		);
		if (!space || !video || video.orgId !== space.organizationId)
			throw new Error("Space or video not found");
		await requireOrganizationManager(snapshot, space.organizationId, addedById);
		await requireOrganizationMember(
			snapshot,
			space.organizationId,
			video.ownerId,
		);
		const [existing] = await snapshot.read((reader) =>
			reader
				.select({ id: spaceVideos.id })
				.from(spaceVideos)
				.where(
					and(
						eq(spaceVideos.spaceId, spaceId),
						eq(spaceVideos.videoId, videoId),
					),
				)
				.limit(1),
		);
		return {
			statements: existing
				? []
				: [
						database
							.insert(spaceVideos)
							.values({ id, spaceId, videoId, addedById }),
					],
			result: undefined,
		};
	});
}

export async function addImportOwnerToSpace({
	spaceId,
	userId,
	actorId,
}: {
	spaceId: Space.SpaceIdOrOrganisationId;
	userId: User.UserId;
	actorId: User.UserId;
}) {
	const database = db();
	const id = SpaceMemberId.make(nanoId());
	await atomic(database, async (snapshot) => {
		const [space] = await snapshot.read((reader) =>
			reader
				.select()
				.from(spaces)
				.where(eq(spaces.id, spaceId as Space.SpaceId))
				.limit(1),
		);
		if (!space) throw new Error("Space not found");
		await requireOrganizationManager(snapshot, space.organizationId, actorId);
		await requireOrganizationMember(snapshot, space.organizationId, userId);
		const [existing] = await snapshot.read((reader) =>
			reader
				.select({ id: spaceMembers.id })
				.from(spaceMembers)
				.where(
					and(
						eq(spaceMembers.spaceId, spaceId),
						eq(spaceMembers.userId, userId),
					),
				)
				.limit(1),
		);
		return {
			statements: existing
				? []
				: [
						database.insert(spaceMembers).values({
							id,
							spaceId,
							userId,
							role: space.createdById === userId ? "admin" : "member",
						}),
					],
			result: undefined,
		};
	});
}

async function getOrCreatePersonalImportFolder({
	orgId,
	ownerId,
	actorId,
	name,
}: {
	orgId: Organisation.OrganisationId;
	ownerId: User.UserId;
	actorId: User.UserId;
	name: string;
}) {
	const database = db();
	const id = Folder.FolderId.make(nanoId());
	return atomic(database, async (snapshot) => {
		await requireOrganizationMember(snapshot, orgId, ownerId);
		await requireOrganizationManager(snapshot, orgId, actorId);
		const candidates = await snapshot.read((reader) =>
			reader
				.select({ id: folders.id, name: folders.name })
				.from(folders)
				.where(
					and(
						eq(folders.organizationId, orgId),
						eq(folders.createdById, ownerId),
						isNull(folders.spaceId),
						isNull(folders.parentId),
					),
				)
				.orderBy(asc(folders.createdAt)),
		);
		const existing = candidates.find(
			(candidate) =>
				getSpaceNameCacheKey(candidate.name) === getSpaceNameCacheKey(name),
		);
		return {
			statements: existing
				? []
				: [
						database.insert(folders).values({
							id,
							name,
							organizationId: orgId,
							createdById: ownerId,
						}),
					],
			result: existing?.id ?? id,
		};
	});
}

export async function processLoomCsvRows({
	rows,
	orgId,
	actorId,
	migrationRequestId,
	migrationLeaseToken,
	allowFolders = false,
	importPriority,
}: {
	rows: LoomCsvImportRow[];
	orgId: Organisation.OrganisationId;
	actorId: User.UserId;
	migrationRequestId?: string;
	migrationLeaseToken?: string;
	allowFolders?: boolean;
	importPriority?: "customer" | "bulk";
}): Promise<LoomCsvImportResult> {
	const inputRows = Array.isArray(rows) ? rows : [];
	const normalizedRows = inputRows
		.map((row, index) => ({
			rowNumber:
				Number.isInteger(row.rowNumber) && row.rowNumber > 0
					? row.rowNumber
					: index + 2,
			loomUrl: typeof row.loomUrl === "string" ? row.loomUrl.trim() : "",
			userEmail:
				typeof row.userEmail === "string"
					? normalizeImportEmail(row.userEmail)
					: "",
			spaceName:
				typeof row.spaceName === "string"
					? normalizeImportSpaceName(row.spaceName)
					: "",
			folderName:
				allowFolders && typeof row.folderName === "string"
					? normalizeImportSpaceName(row.folderName)
					: "",
		}))
		.filter((row) => row.loomUrl || row.userEmail || row.spaceName);

	if (normalizedRows.length === 0) {
		return {
			success: false,
			importedCount: 0,
			failedCount: 0,
			results: [],
			error: "No rows found to import.",
		};
	}

	if (normalizedRows.length > MAX_LOOM_CSV_ROWS) {
		return {
			success: false,
			importedCount: 0,
			failedCount: normalizedRows.length,
			results: [],
			error: LOOM_CSV_LIMIT_ERROR,
		};
	}

	const results: LoomCsvImportRowResult[] = [];
	const spaceCache = new Map<string, ImportSpaceCacheValue>();
	const touchedSpaceIds = new Set<Space.SpaceIdOrOrganisationId>();

	for (const row of normalizedRows) {
		if (migrationRequestId) {
			if (!migrationLeaseToken) {
				throw new LoomMigrationError(
					"The concierge import is missing its reservation.",
				);
			}
			await renewConciergeImport(migrationRequestId, migrationLeaseToken);
		}
		if (!row.loomUrl) {
			results.push({
				rowNumber: row.rowNumber,
				userEmail: row.userEmail,
				spaceName: row.spaceName || undefined,
				success: false,
				error: "Missing Loom video URL.",
			});
			continue;
		}

		if (!isValidImportEmail(row.userEmail)) {
			results.push({
				rowNumber: row.rowNumber,
				userEmail: row.userEmail,
				spaceName: row.spaceName || undefined,
				success: false,
				error: "Missing or invalid user email.",
			});
			continue;
		}

		if (!isValidImportSpaceName(row.spaceName)) {
			results.push({
				rowNumber: row.rowNumber,
				userEmail: row.userEmail,
				spaceName: row.spaceName,
				success: false,
				error: `Space name must be ${MAX_LOOM_SPACE_NAME_LENGTH} characters or fewer.`,
			});
			continue;
		}

		let member = await getOrganizationMemberByEmail(orgId, row.userEmail);

		if (!member) {
			try {
				const provisionedMember = await provisionOrganizationInvitee({
					organizationId: orgId,
					email: row.userEmail,
					invitedByUserId: actorId,
					role: "member",
				});
				member = {
					userId: provisionedMember.userId,
					email: row.userEmail,
				};
			} catch {
				results.push({
					rowNumber: row.rowNumber,
					userEmail: row.userEmail,
					spaceName: row.spaceName || undefined,
					success: false,
					error: "Could not add this email to the organization.",
				});
				continue;
			}
		}

		try {
			const folderId = row.folderName
				? await getOrCreatePersonalImportFolder({
						orgId,
						ownerId: member.userId,
						actorId,
						name: row.folderName,
					})
				: undefined;
			const result = await importLoomVideoForOwner({
				loomUrl: row.loomUrl,
				orgId,
				ownerId: member.userId,
				actorId,
				destination: folderId ? { folderId } : {},
				migrationRequestId,
				migrationLeaseToken,
				importPriority,
			});

			let spaceName = row.spaceName || undefined;
			let spaceError: string | undefined;
			if (result.success && result.videoId && row.spaceName) {
				try {
					const space = await getOrCreateImportSpace({
						orgId,
						createdById: actorId,
						name: row.spaceName,
						spaceCache,
					});
					await addImportedVideoToSpace({
						videoId: result.videoId,
						spaceId: space.id,
						addedById: actorId,
					});
					await addImportOwnerToSpace({
						spaceId: space.id,
						userId: member.userId,
						actorId,
					});
					touchedSpaceIds.add(space.id);
					spaceName = space.name;
				} catch {
					spaceError = "Import started, but it could not be added to a space.";
				}
			}

			results.push({
				rowNumber: row.rowNumber,
				userEmail: row.userEmail,
				spaceName,
				success: result.success,
				videoId: result.videoId,
				error: result.error ?? spaceError,
				...(result.errorCode ? { errorCode: result.errorCode } : {}),
			});
		} catch {
			results.push({
				rowNumber: row.rowNumber,
				userEmail: row.userEmail,
				spaceName: row.spaceName || undefined,
				success: false,
				error: "Failed to start this import.",
			});
		}
	}

	const importedCount = results.filter((result) => result.success).length;
	const failedCount = results.length - importedCount;

	for (const spaceId of touchedSpaceIds) {
		revalidatePath(`/dashboard/spaces/${spaceId}`);
	}

	if (touchedSpaceIds.size > 0) {
		revalidatePath("/dashboard");
	}

	return {
		success: importedCount > 0,
		importedCount,
		failedCount,
		results,
		error: importedCount > 0 ? undefined : "No Loom videos were imported.",
	};
}
