"use server";

import { getCurrentUser } from "@cap/database/auth/session";
import { db } from "@cap/database/cloudflare/application";
import {
	videoEdits,
	videos,
	videoUploads,
} from "@cap/database/cloudflare/schema";
import type { VideoEditSpec } from "@cap/database/types";
import { serverEnv } from "@cap/env";
import { userIsPro } from "@cap/utils";
import { writableVideo } from "@cap/web-backend/src/Videos/persistence";
import type { Video } from "@cap/web-domain";
import { and, eq } from "drizzle-orm";
import { revalidatePath } from "next/cache";
import { start } from "workflow/api";
import { assertLegacyEditsQuiescent } from "@/lib/legacy-video-edit-recovery";
import { runPromise } from "@/lib/server";
import { clearPendingEdit } from "@/lib/video-edit-operation";
import { getEditSourceKey, isEditSourceKey } from "@/lib/video-edit-processing";
import {
	ensureOriginalSourceCopy,
	getCompletedProcessingReceipt,
	getVideoBucket,
	markEditProcessing,
	objectExists,
} from "@/lib/video-edit-start";
import { getVideoEditingBase } from "@/lib/video-editing-base";
import {
	areEditSpecsEquivalent,
	composeEditSpecs,
	createIdentityEditSpec,
	getEditSpecOutputDuration,
	normalizeKeepRanges,
} from "@/lib/video-edits";
import { isAiGenerationEnabled } from "@/utils/flags";
import { editVideoWorkflow } from "@/workflows/edit-video";

const ACTIVE_UPLOAD_PHASES = new Set([
	"uploading",
	"processing",
	"generating_thumbnail",
	"complete",
	"error",
]);

function isMp4BackedVideo(source: typeof videos.$inferSelect.source) {
	return source.type === "desktopMP4" || source.type === "webMP4";
}

async function loadEditableVideo(
	videoId: Video.VideoId,
	recoverLegacy = false,
) {
	const user = await getCurrentUser();
	if (!user) throw new Error("Unauthorized");
	if (!userIsPro(user)) throw new Error("Cap Pro is required to edit videos");

	const [video] = await db()
		.select()
		.from(videos)
		.where(and(writableVideo, eq(videos.id, videoId)));

	if (!video) throw new Error("Video not found");
	if (video.ownerId !== user.id) throw new Error("Forbidden");
	if (video.isScreenshot) throw new Error("Screenshots cannot be edited");
	if (!isMp4BackedVideo(video.source)) {
		throw new Error("Only processed MP4 videos can be edited");
	}

	const [activeUpload] = await db()
		.select()
		.from(videoUploads)
		.where(eq(videoUploads.videoId, videoId));
	const completedUpload = getCompletedProcessingReceipt(video, activeUpload);
	if (completedUpload)
		return { user, video, legacyUpload: undefined, completedUpload };

	if (
		recoverLegacy &&
		activeUpload &&
		!video.metadata?.editProcessing &&
		isEditSourceKey({
			ownerId: video.ownerId,
			videoId,
			rawFileKey: activeUpload.rawFileKey,
			metadata: video.metadata,
		})
	) {
		if (
			!("workflowId" in editVideoWorkflow) ||
			typeof editVideoWorkflow.workflowId !== "string"
		) {
			throw new Error("The edit recovery runtime is unavailable");
		}
		await assertLegacyEditsQuiescent(editVideoWorkflow.workflowId);
		return {
			user,
			video,
			legacyUpload: activeUpload,
			completedUpload: undefined,
		};
	}
	if (activeUpload && ACTIVE_UPLOAD_PHASES.has(activeUpload.phase)) {
		const message =
			activeUpload.phase === "complete"
				? "Previous edit is finishing up. Try again in a moment."
				: activeUpload.phase === "error"
					? "Previous edit failed and is being cleaned up. Try again in a moment."
					: "Video is already uploading or processing";
		throw new Error(message);
	}

	return { user, video, legacyUpload: undefined, completedUpload: undefined };
}

export async function saveVideoEdits(
	videoId: Video.VideoId,
	editSpec: VideoEditSpec,
) {
	const { user, video, completedUpload } = await loadEditableVideo(videoId);

	const [existingEdit] = await db()
		.select()
		.from(videoEdits)
		.where(eq(videoEdits.videoId, videoId));

	const previousSpec =
		existingEdit?.editSpec ??
		createIdentityEditSpec(
			getVideoEditingBase(video)?.duration ??
				video.duration ??
				editSpec.sourceDuration,
		);
	const expectedCurrentDuration = existingEdit
		? getEditSpecOutputDuration(previousSpec)
		: (getVideoEditingBase(video)?.duration ??
			video.duration ??
			editSpec.sourceDuration);
	const currentOutputSpec = normalizeKeepRanges(
		editSpec.keepRanges,
		expectedCurrentDuration,
	);

	if (getEditSpecOutputDuration(currentOutputSpec) <= 0) {
		throw new Error("Edit must keep at least one playable range");
	}

	const normalizedEditSpec = existingEdit
		? composeEditSpecs(previousSpec, currentOutputSpec)
		: currentOutputSpec;

	if (areEditSpecsEquivalent(previousSpec, normalizedEditSpec)) {
		revalidatePath(`/s/${videoId}/edit`);
		return { success: true, skipped: true };
	}

	const sourceKey =
		existingEdit?.sourceKey ??
		getEditSourceKey(video.ownerId, video.id, video.metadata);
	const aiGenerationEnabled = await isAiGenerationEnabled(user);
	const operation = await markEditProcessing({
		video,
		sourceKey,
		previousSpec,
		completedUpload,
	});
	try {
		await ensureOriginalSourceCopy(
			video,
			sourceKey,
			!existingEdit && !getVideoEditingBase(video),
		);
	} catch (error) {
		await clearPendingEdit(videoId, sourceKey, operation);
		throw error;
	}

	try {
		await start(editVideoWorkflow, [
			{
				videoId,
				userId: user.id,
				sourceKey,
				previousSpec,
				editSpec: normalizedEditSpec,
				keepRanges: normalizedEditSpec.keepRanges,
				aiGenerationEnabled,
				operation,
			},
		]);
	} catch (error) {
		await clearPendingEdit(videoId, sourceKey, operation);
		throw error instanceof Error
			? error
			: new Error("Video edit could not start");
	}

	revalidatePath(`/s/${videoId}`);
	revalidatePath(`/s/${videoId}/edit`);
	revalidatePath("/dashboard/caps");

	return { success: true };
}

export async function restoreVideoToOriginal(videoId: Video.VideoId) {
	const { user, video, legacyUpload, completedUpload } =
		await loadEditableVideo(videoId, true);

	const [existingEdit] = await db()
		.select()
		.from(videoEdits)
		.where(eq(videoEdits.videoId, videoId));

	if (!existingEdit && !legacyUpload) {
		revalidatePath(`/s/${videoId}/edit`);
		return { success: true, skipped: true };
	}

	const sourceKey =
		existingEdit?.sourceKey ??
		getEditSourceKey(video.ownerId, video.id, video.metadata);
	const bucket = await getVideoBucket(video);
	if (!(await objectExists(bucket, sourceKey)))
		throw new Error("Original video is no longer available");
	let sourceDuration =
		existingEdit?.editSpec.sourceDuration ??
		getVideoEditingBase(video)?.duration ??
		video.duration ??
		0;
	if (legacyUpload) {
		const mediaServerUrl = serverEnv().MEDIA_SERVER_URL;
		if (!mediaServerUrl)
			throw new Error("Video recovery is temporarily unavailable");
		const sourceUrl = await bucket
			.getInternalSignedObjectUrl(sourceKey, { expiresIn: 300 })
			.pipe(runPromise);
		const response = await fetch(`${mediaServerUrl}/video/probe`, {
			method: "POST",
			headers: {
				"Content-Type": "application/json",
				"x-media-server-secret": serverEnv().MEDIA_SERVER_WEBHOOK_SECRET ?? "",
			},
			body: JSON.stringify({ videoUrl: sourceUrl }),
			signal: AbortSignal.timeout(30_000),
		});
		const result: unknown = await response.json();
		if (
			!response.ok ||
			!result ||
			typeof result !== "object" ||
			!("metadata" in result) ||
			!result.metadata ||
			typeof result.metadata !== "object" ||
			!("duration" in result.metadata) ||
			typeof result.metadata.duration !== "number" ||
			!Number.isFinite(result.metadata.duration) ||
			result.metadata.duration <= 0
		) {
			throw new Error("The original video could not be verified for recovery");
		}
		sourceDuration = result.metadata.duration;
	}
	const previousSpec =
		existingEdit?.editSpec ??
		createIdentityEditSpec(
			getVideoEditingBase(video)?.duration ?? video.duration ?? sourceDuration,
		);
	const restoredSpec = createIdentityEditSpec(sourceDuration);
	if (getEditSpecOutputDuration(restoredSpec) <= 0)
		throw new Error("Original video is no longer available");
	if (!legacyUpload && areEditSpecsEquivalent(previousSpec, restoredSpec)) {
		revalidatePath(`/s/${videoId}/edit`);
		return { success: true, skipped: true };
	}

	const aiGenerationEnabled = await isAiGenerationEnabled(user);

	const operation = await markEditProcessing({
		video,
		sourceKey,
		previousSpec,
		legacyUpload,
		completedUpload,
	});

	try {
		await start(editVideoWorkflow, [
			{
				videoId,
				userId: user.id,
				sourceKey,
				previousSpec,
				editSpec: restoredSpec,
				keepRanges: restoredSpec.keepRanges,
				aiGenerationEnabled,
				operation,
			},
		]);
	} catch (error) {
		await clearPendingEdit(videoId, sourceKey, operation);
		throw error instanceof Error
			? error
			: new Error("Video restore could not start");
	}

	revalidatePath(`/s/${videoId}`);
	revalidatePath(`/s/${videoId}/edit`);
	revalidatePath("/dashboard/caps");

	return { success: true };
}
