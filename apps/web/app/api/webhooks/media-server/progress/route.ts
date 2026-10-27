import { createHash, timingSafeEqual } from "node:crypto";
import { db } from "@cap/database/cloudflare/application";
import { type AtomicStatement, atomic } from "@cap/database/cloudflare/atomic";
import { videos, videoUploads } from "@cap/database/cloudflare/schema";
import { serverEnv } from "@cap/env";
import { requireWritableVideo } from "@cap/web-backend/src/Videos/persistence";
import { Video } from "@cap/web-domain";
import { eq } from "drizzle-orm";
import { type NextRequest, NextResponse } from "next/server";
import { handleAudioLevelPublication } from "@/lib/audio-level-publication";
import { SourceCommitPendingError } from "@/lib/desktop-recording-jobs";
import { applyDesktopRecordingProgress } from "@/lib/desktop-recording-publication";
import { createVerifiedRecordingReceipt } from "@/lib/desktop-recording-upload-status";
import {
	type RecordingVerification,
	recordingVerificationSchema,
} from "@/lib/desktop-recording-verification";
import { queueDesktopSegmentsFinalization } from "@/lib/desktop-segments-finalization";
import { invalidateGoogleDriveStorageQuotaCache } from "@/lib/google-drive-storage-quota";
import { loomImportSourcePublication } from "@/lib/loom-import-artifacts";
import { signalLoomImportFinished } from "@/lib/loom-import-signal";
import { getLoomImportSignalToken } from "@/lib/loom-import-signal-token";
import { ownsLoomImportSource } from "@/lib/loom-import-state";
import {
	queueVideoTranscription,
	shouldQueueTranscriptionAfterMediaComplete,
} from "@/lib/queue-video-transcription";
import { isEditSourceKey } from "@/lib/video-edit-processing";
import { applyEditProgress } from "@/lib/video-edit-progress";
import { applyVideoProcessingProgress } from "@/lib/video-processing-state";

interface ProgressWebhookPayload {
	manifestSha256?: string;
	recordingVerification?: {
		request: RecordingVerification;
		fullDecode: boolean;
		objectIdentity?: string;
	};
	jobId: string;
	videoId: string;
	phase:
		| "queued"
		| "downloading"
		| "probing"
		| "processing"
		| "uploading"
		| "generating_thumbnail"
		| "complete"
		| "error"
		| "cancelled";
	progress: number;
	message?: string;
	error?: string;
	metadata?: {
		duration: number;
		width: number;
		height: number;
		fps: number;
		videoCodec: string;
		audioCodec: string | null;
		audioChannels: number | null;
		sampleRate: number | null;
		bitrate: number;
		fileSize: number;
	};
	deferredSourceKey?: string;
}

const MEDIA_SERVER_SHUTDOWN_MESSAGE = "Server shutting down";

function getValidDuration(duration: number) {
	return Number.isFinite(duration) && duration > 0 ? duration : undefined;
}

function mapPhaseToDbPhase(
	phase: ProgressWebhookPayload["phase"],
): "uploading" | "processing" | "generating_thumbnail" | "complete" | "error" {
	switch (phase) {
		case "queued":
		case "downloading":
		case "probing":
		case "processing":
		case "uploading":
			return "processing";
		case "generating_thumbnail":
			return "generating_thumbnail";
		case "complete":
			return "complete";
		case "error":
		case "cancelled":
			return "error";
		default:
			return "processing";
	}
}

export async function POST(request: NextRequest) {
	try {
		const webhookSecret = serverEnv().MEDIA_SERVER_WEBHOOK_SECRET;
		const authHeader = request.headers.get("x-media-server-secret");
		// Hash both sides to a fixed-length digest before the constant-time
		// compare. This avoids comparing raw inputs whose UTF-8 byte length can
		// differ from their UTF-16 `.length` (which would throw a RangeError) and
		// removes the length pre-check that would otherwise leak the secret size.
		const digest = (value: string) =>
			createHash("sha256").update(value, "utf8").digest();
		if (
			!webhookSecret ||
			!authHeader ||
			!timingSafeEqual(digest(authHeader), digest(webhookSecret))
		) {
			return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
		}

		const body: unknown = await request.json();
		if (
			body &&
			typeof body === "object" &&
			"kind" in body &&
			body.kind === "audio-levels"
		)
			return NextResponse.json(await handleAudioLevelPublication(body));
		const payload = body as ProgressWebhookPayload;
		if (
			!payload ||
			typeof payload.videoId !== "string" ||
			typeof payload.jobId !== "string" ||
			![
				"queued",
				"downloading",
				"probing",
				"processing",
				"uploading",
				"generating_thumbnail",
				"complete",
				"error",
				"cancelled",
			].includes(payload.phase) ||
			!Number.isFinite(payload.progress)
		)
			return NextResponse.json(
				{ error: "Invalid progress payload" },
				{ status: 400 },
			);
		if (
			await applyEditProgress(
				payload,
				request.nextUrl.searchParams.get("editOperation"),
				request.nextUrl.searchParams.get("editStartedAt"),
			)
		) {
			return NextResponse.json({ success: true });
		}
		const recordingProgress = await applyDesktopRecordingProgress(payload);
		if (recordingProgress.handled) {
			if (recordingProgress.published) {
				try {
					await queueVideoTranscription(payload.videoId as Video.VideoId);
				} catch {
					console.warn(
						"[media-server-webhook] Transcription queue unavailable",
						{
							videoId: payload.videoId,
						},
					);
				}
			}
			return NextResponse.json(
				{
					success: recordingProgress.status === 200,
					...(recordingProgress.recordingWorker
						? { recordingWorker: recordingProgress.recordingWorker }
						: {}),
				},
				{ status: recordingProgress.status ?? 200 },
			);
		}
		const dbPhase = mapPhaseToDbPhase(payload.phase);
		const processingToken = request.nextUrl.searchParams.get("processingRun");
		const attemptId = request.nextUrl.searchParams.get("processingAttempt");
		if (processingToken || attemptId) {
			if (
				!processingToken ||
				!attemptId ||
				!/^[0-9a-f-]{36}$/i.test(processingToken) ||
				!/^[0-9a-f-]{36}$/i.test(attemptId)
			)
				return NextResponse.json(
					{ error: "Invalid processing run" },
					{ status: 400 },
				);
			const applied = await applyVideoProcessingProgress(db(), {
				videoId: Video.VideoId.make(payload.videoId),
				token: processingToken,
				attemptId,
				jobId: payload.jobId,
				phase: dbPhase === "uploading" ? "processing" : dbPhase,
				progress: payload.progress,
				message: payload.message,
				error: payload.error,
				metadata: payload.metadata,
			});
			if (applied && dbPhase === "complete") {
				await queueVideoTranscription(Video.VideoId.make(payload.videoId));
			}
			return NextResponse.json({
				success: true,
				status: applied ? "applied" : "stale-processing-run",
			});
		}
		const database = db();
		const videoId = Video.VideoId.make(payload.videoId);
		const [currentVideo] = await database
			.select()
			.from(videos)
			.where(eq(videos.id, videoId));
		if (!currentVideo)
			return NextResponse.json({ success: true, status: "video-removed" });
		if (
			currentVideo.metadata?.processingRun ||
			currentVideo.metadata?.editProcessing
		)
			return NextResponse.json({
				success: true,
				status: "stale-processing-run",
			});
		const loomAttempt = currentVideo.metadata?.loomImportRun?.mediaDispatch;
		if (
			loomAttempt &&
			!ownsLoomImportSource(
				currentVideo,
				currentVideo.metadata?.loomImportRun?.runId ?? "",
			)
		)
			return NextResponse.json({
				success: true,
				status: "stale-import-source",
			});
		if (
			loomAttempt &&
			(request.nextUrl.searchParams.get("signal") !==
				getLoomImportSignalToken(videoId, loomAttempt.attemptId) ||
				(loomAttempt.jobId && loomAttempt.jobId !== payload.jobId))
		)
			return NextResponse.json({ success: true, status: "stale-import-run" });
		if (
			process.env.CAP_RUNTIME === "cloudflare" &&
			!recordingProgress.allowLegacyProcessing &&
			!currentVideo.metadata?.loomImportRun &&
			currentVideo.source.type !== "desktopMP4" &&
			currentVideo.source.type !== "desktopSegments"
		)
			return NextResponse.json(
				{ error: "Processing run token is required" },
				{ status: 409 },
			);
		const [currentUpload] = await database
			.select()
			.from(videoUploads)
			.where(eq(videoUploads.videoId, videoId));
		const isEditUpload = isEditSourceKey({
			ownerId: currentVideo.ownerId,
			videoId,
			rawFileKey: currentUpload?.rawFileKey,
		});
		const proof = payload.recordingVerification;
		if (
			dbPhase === "complete" &&
			!isEditUpload &&
			!recordingProgress.allowLegacyProcessing &&
			(currentVideo.source.type === "desktopMP4" ||
				currentVideo.source.type === "desktopSegments")
		) {
			try {
				await queueDesktopSegmentsFinalization({
					videoId,
					userId: currentVideo.ownerId,
					verification: proof
						? recordingVerificationSchema.parse(proof.request)
						: undefined,
				});
			} catch (error) {
				if (!(error instanceof SourceCommitPendingError)) throw error;
			}
			return NextResponse.json({
				success: true,
				status: "queued-for-verification",
			});
		}
		const receipt =
			dbPhase === "complete" && proof
				? payload.metadata
					? await createVerifiedRecordingReceipt(
							currentVideo,
							recordingVerificationSchema.parse(proof.request),
							payload.metadata,
							proof.fullDecode,
							proof.objectIdentity,
						)
					: null
				: undefined;
		if (receipt === null)
			return NextResponse.json(
				{ error: "Recording completion is missing required verification data" },
				{ status: 503 },
			);
		const transcribeOnView =
			request.nextUrl.searchParams.get("transcription") === "on-view";
		const previewOnView =
			request.nextUrl.searchParams.get("preview") === "on-view";
		const deferredSourceKey =
			typeof payload.deferredSourceKey === "string" &&
			payload.deferredSourceKey.startsWith(
				`${currentVideo.ownerId}/${videoId}/`,
			) &&
			!payload.deferredSourceKey.includes("..") &&
			payload.deferredSourceKey.endsWith(".webm")
				? payload.deferredSourceKey
				: undefined;
		const retryable =
			request.nextUrl.searchParams.get("retryable") === "true" &&
			(payload.phase === "error" ||
				(payload.phase === "cancelled" &&
					payload.message === MEDIA_SERVER_SHUTDOWN_MESSAGE));
		const now = new Date();
		const applied = await atomic(database, async (snapshot) => {
			const video = await requireWritableVideo(
				snapshot,
				videoId,
				currentVideo.ownerId,
			);
			if (
				video.bucket !== currentVideo.bucket ||
				video.storageIntegrationId !== currentVideo.storageIntegrationId ||
				JSON.stringify(video.source) !== JSON.stringify(currentVideo.source) ||
				JSON.stringify(video.metadata?.loomImportRun) !==
					JSON.stringify(currentVideo.metadata?.loomImportRun) ||
				video.metadata?.processingRun ||
				video.metadata?.editProcessing
			)
				return { statements: [], result: false };
			const [upload] = await snapshot.read((reader) =>
				reader
					.select()
					.from(videoUploads)
					.where(eq(videoUploads.videoId, videoId)),
			);
			if (!upload || upload.rawFileKey !== currentUpload?.rawFileKey)
				return { statements: [], result: false };
			const statements: AtomicStatement[] = [];
			if (dbPhase === "complete") {
				const metadata = { ...video.metadata };
				if (transcribeOnView) metadata.transcribeOnView = true;
				if (previewOnView && !payload.deferredSourceKey)
					metadata.loomPreviewGif ??= { status: "pending" };
				if (
					metadata.loomDeferredProcessing &&
					upload.rawFileKey === metadata.loomDeferredProcessing.rawFileKey
				)
					metadata.loomDeferredProcessing = {
						...metadata.loomDeferredProcessing,
						status: "complete",
					};
				if (deferredSourceKey)
					metadata.loomDeferredProcessing ??= {
						rawFileKey: deferredSourceKey,
						status: "pending",
					};
				if (receipt) metadata.desktopRecordingUpload = receipt;
				statements.push(
					database
						.update(videos)
						.set({
							metadata,
							...loomImportSourcePublication(video, metadata),
							...(receipt ? { source: { type: "desktopMP4" as const } } : {}),
							...(payload.metadata
								? {
										width: payload.metadata.width,
										height: payload.metadata.height,
										fps: payload.metadata.fps,
										...(getValidDuration(payload.metadata.duration) !==
										undefined
											? {
													duration: getValidDuration(payload.metadata.duration),
												}
											: {}),
									}
								: {}),
						})
						.where(eq(videos.id, videoId)),
				);
				if (isEditUpload)
					statements.push(
						database
							.update(videoUploads)
							.set({
								phase: "complete",
								processingProgress: 100,
								processingMessage: payload.message,
								processingError: null,
								updatedAt: now,
							})
							.where(eq(videoUploads.videoId, videoId)),
					);
				else if (!deferredSourceKey || upload.rawFileKey !== deferredSourceKey)
					statements.push(
						database
							.delete(videoUploads)
							.where(eq(videoUploads.videoId, videoId)),
					);
			} else {
				const error =
					dbPhase === "error"
						? (payload.error ?? payload.message ?? "Unknown error")
						: null;
				statements.push(
					database
						.update(videoUploads)
						.set({
							phase: retryable ? "processing" : dbPhase,
							processingProgress: Math.min(
								100,
								Math.max(0, Math.round(payload.progress)),
							),
							processingError: error,
							processingMessage: retryable
								? "Retrying video processing..."
								: payload.message,
							updatedAt: now,
						})
						.where(eq(videoUploads.videoId, videoId)),
				);
			}
			return { statements, result: true };
		});
		if (applied && dbPhase === "complete") {
			await invalidateGoogleDriveStorageQuotaCache(
				currentVideo.storageIntegrationId,
			);
			if (
				!transcribeOnView &&
				shouldQueueTranscriptionAfterMediaComplete(
					currentVideo.source.type,
					Boolean(isEditUpload),
				)
			)
				await queueVideoTranscription(videoId);
		}
		if (applied && (dbPhase === "complete" || dbPhase === "error"))
			await signalLoomImportFinished(
				request.nextUrl.searchParams.get("signal"),
				videoId,
				payload.phase,
			);

		return NextResponse.json({ success: true });
	} catch (error) {
		console.error("[media-server-webhook] Error processing webhook:", error);
		return NextResponse.json(
			{ error: "Internal server error" },
			{ status: 500 },
		);
	}
}
