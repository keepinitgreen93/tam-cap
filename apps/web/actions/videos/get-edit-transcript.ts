"use server";

import { randomUUID } from "node:crypto";
import { getCurrentUser } from "@cap/database/auth/session";
import { requireActiveOrganization } from "@cap/database/cloudflare/access";
import { db } from "@cap/database/cloudflare/application";
import { atomic } from "@cap/database/cloudflare/atomic";
import { videoEdits, videos } from "@cap/database/cloudflare/schema";
import { userIsPro } from "@cap/utils";
import { Storage } from "@cap/web-backend";
import type { Video } from "@cap/web-domain";
import { and, eq, sql } from "drizzle-orm";
import { Option } from "effect";
import { start } from "workflow/api";
import {
	type EditTranscript,
	type EditTranscriptBackfillStatus,
	getEditTranscriptBackfillStatus,
	parseEditTranscript,
	remapEditTranscriptThroughSpec,
} from "@/lib/edit-transcript";
import { runPromise } from "@/lib/server";
import { readOriginalEditTranscript } from "@/lib/transcript-publication";
import { getVideoEditingBase } from "@/lib/video-editing-base";
import { decodeStorageVideo } from "@/lib/video-storage";
import { backfillEditTranscriptWorkflow } from "@/workflows/transcribe";

type EditTranscriptResponse =
	| { status: "ready"; transcript: EditTranscript }
	| { status: "missing" }
	| { status: "processing" }
	| { status: "error"; message: string };

const BACKFILL_STALE_AFTER_MS = 60 * 60 * 1000;
const PUBLIC_ERROR_MESSAGES = new Set([
	"Unauthorized",
	"Cap Pro is required",
	"Video not found",
	"Transcript editing is not available for this video",
	"Transcript is not ready",
]);

function isMp4BackedVideo(source: typeof videos.$inferSelect.source) {
	return source.type === "desktopMP4" || source.type === "webMP4";
}

function isEditableTranscriptVideo(video: typeof videos.$inferSelect) {
	return (
		video.transcriptionStatus === "COMPLETE" &&
		!video.isScreenshot &&
		isMp4BackedVideo(video.source) &&
		Boolean(video.duration && video.duration > 0)
	);
}

function getPublicErrorMessage(error: unknown, fallback: string) {
	return isPublicError(error) ? error.message : fallback;
}

function isPublicError(error: unknown): error is Error {
	return error instanceof Error && PUBLIC_ERROR_MESSAGES.has(error.message);
}

async function loadEditableTranscriptVideo(videoId: Video.VideoId) {
	const user = await getCurrentUser();
	if (!user) throw new Error("Unauthorized");
	if (!userIsPro(user)) throw new Error("Cap Pro is required");

	const [video] = await db()
		.select()
		.from(videos)
		.where(eq(videos.id, videoId));
	if (!video || video.ownerId !== user.id) throw new Error("Video not found");
	if (!isEditableTranscriptVideo(video)) {
		if (video.transcriptionStatus !== "COMPLETE") {
			throw new Error("Transcript is not ready");
		}
		throw new Error("Transcript editing is not available for this video");
	}

	const [bucket] = await Storage.getAccessForVideo(
		decodeStorageVideo(video),
	).pipe(runPromise);

	return { user, video, bucket };
}

function isFreshProcessingStatus(status: EditTranscriptBackfillStatus) {
	if (status.status !== "processing") return false;
	const requestedAt = Date.parse(status.requestedAt);
	return (
		Number.isFinite(requestedAt) &&
		Date.now() - requestedAt < BACKFILL_STALE_AFTER_MS
	);
}

function isDurationCurrent(durationMs: number, expectedSeconds: number) {
	return Math.abs(durationMs - Math.round(expectedSeconds * 1000)) <= 250;
}

/**
 * Reads the stored word transcript. Stored words always describe the ORIGINAL
 * media, so for edited videos they are checked against the edit spec's source
 * duration and remapped onto the current output timeline before being returned.
 */
async function readCurrentEditTranscript(
	bucket: Awaited<ReturnType<typeof loadEditableTranscriptVideo>>["bucket"],
	video: typeof videos.$inferSelect,
): Promise<EditTranscript | null> {
	const decrypted = await readOriginalEditTranscript(video, {
		getText: async (key) =>
			Option.getOrNull(await bucket.getObject(key).pipe(runPromise)),
	});
	const transcript = decrypted ? parseEditTranscript(decrypted) : null;
	if (!transcript) return null;

	const [edit] = await db()
		.select({ editSpec: videoEdits.editSpec })
		.from(videoEdits)
		.where(eq(videoEdits.videoId, video.id));

	if (!edit?.editSpec) {
		return isDurationCurrent(
			transcript.durationMs,
			getVideoEditingBase(video)?.duration ?? video.duration ?? 0,
		)
			? transcript
			: null;
	}

	return isDurationCurrent(transcript.durationMs, edit.editSpec.sourceDuration)
		? remapEditTranscriptThroughSpec(transcript, edit.editSpec)
		: null;
}

export async function getEditTranscript(
	videoId: Video.VideoId,
): Promise<EditTranscriptResponse> {
	try {
		const { video, bucket } = await loadEditableTranscriptVideo(videoId);
		const transcript = await readCurrentEditTranscript(bucket, video);

		if (transcript) {
			return { status: "ready", transcript };
		}

		const status = getEditTranscriptBackfillStatus(video.metadata);
		if (status && isFreshProcessingStatus(status)) {
			return { status: "processing" };
		}
		if (status?.status === "processing") {
			return {
				status: "error",
				message: "Transcript preparation stalled. Try again.",
			};
		}
		if (status?.status === "error") {
			return {
				status: "error",
				message: "Transcript preparation failed. Try again.",
			};
		}
		return { status: "missing" };
	} catch (error) {
		if (!isPublicError(error)) {
			console.error(
				`[editTranscript] Failed to load transcript for ${videoId}`,
				error,
			);
		}
		return {
			status: "error",
			message: getPublicErrorMessage(error, "Transcript unavailable"),
		};
	}
}

async function claimEditTranscriptBackfill(
	videoId: Video.VideoId,
	userId: string,
) {
	const database = db();
	const requestId = randomUUID();
	const requestedAt = new Date().toISOString();
	return atomic(database, async (snapshot) => {
		const [video] = await snapshot.read((reader) =>
			reader.select().from(videos).where(eq(videos.id, videoId)),
		);
		if (!video || video.ownerId !== userId) throw new Error("Video not found");
		if (video.orgId) await requireActiveOrganization(snapshot, video.orgId);
		if (!isEditableTranscriptVideo(video))
			throw new Error("Transcript editing is not available for this video");
		const existing = getEditTranscriptBackfillStatus(video.metadata);
		if (existing && isFreshProcessingStatus(existing))
			return { statements: [], result: { claimed: false as const } };
		return {
			statements: [
				database
					.update(videos)
					.set({
						metadata: {
							...video.metadata,
							editTranscriptBackfill: {
								status: "processing",
								requestId,
								requestedAt,
							},
						},
						updatedAt: video.updatedAt,
					})
					.where(eq(videos.id, videoId)),
			],
			result: { claimed: true as const, requestId },
		};
	});
}
async function setEditTranscriptBackfillError(
	videoId: Video.VideoId,
	requestId: string,
) {
	await db()
		.update(videos)
		.set({
			metadata: sql`JSON_SET(COALESCE(${videos.metadata}, JSON_OBJECT()), '$.editTranscriptBackfill.status', 'error')`,
			updatedAt: sql`${videos.updatedAt}`,
		})
		.where(
			and(
				eq(videos.id, videoId),
				sql`json_extract(${videos.metadata}, '$.editTranscriptBackfill.requestId') = ${requestId}`,
			),
		);
}

async function clearEditTranscriptBackfill(
	videoId: Video.VideoId,
	requestId: string,
) {
	await db()
		.update(videos)
		.set({
			metadata: sql`JSON_REMOVE(COALESCE(${videos.metadata}, JSON_OBJECT()), '$.editTranscriptBackfill')`,
			updatedAt: sql`${videos.updatedAt}`,
		})
		.where(
			and(
				eq(videos.id, videoId),
				sql`json_extract(${videos.metadata}, '$.editTranscriptBackfill.requestId') = ${requestId}`,
			),
		);
}

export async function requestEditTranscript(
	videoId: Video.VideoId,
): Promise<EditTranscriptResponse> {
	try {
		const { user, video, bucket } = await loadEditableTranscriptVideo(videoId);
		const transcript = await readCurrentEditTranscript(bucket, video);
		if (transcript) {
			return { status: "ready", transcript };
		}

		const claim = await claimEditTranscriptBackfill(videoId, user.id);
		if (!claim.claimed) {
			return { status: "processing" };
		}

		const refreshed = await loadEditableTranscriptVideo(videoId);
		const transcriptAfterClaim = await readCurrentEditTranscript(
			refreshed.bucket,
			refreshed.video,
		);
		if (transcriptAfterClaim) {
			await clearEditTranscriptBackfill(videoId, claim.requestId);
			return { status: "ready", transcript: transcriptAfterClaim };
		}

		try {
			await start(backfillEditTranscriptWorkflow, [
				{
					videoId,
					userId: user.id,
					requestId: claim.requestId,
				},
			]);
		} catch (error) {
			console.error(
				`[editTranscript] Failed to start backfill for ${videoId}`,
				error,
			);
			await setEditTranscriptBackfillError(videoId, claim.requestId);
			return {
				status: "error",
				message: "Transcript preparation could not start. Try again.",
			};
		}

		return { status: "processing" };
	} catch (error) {
		if (!isPublicError(error)) {
			console.error(
				`[editTranscript] Failed to request transcript for ${videoId}`,
				error,
			);
		}
		return {
			status: "error",
			message: getPublicErrorMessage(error, "Transcript unavailable"),
		};
	}
}
