import { db } from "@cap/database/cloudflare/application";
import {
	organizations,
	videos,
	videoUploads,
} from "@cap/database/cloudflare/schema";
import {
	claimTranscriptionRun,
	releaseTranscriptionRun,
} from "@cap/database/cloudflare/transcription-state";
import { serverEnv } from "@cap/env";
import type { Video } from "@cap/web-domain";
import { eq } from "drizzle-orm";
import { transcribeVideoWorkflow } from "@/workflows/transcribe";
import { isTranscriptionConfigured } from "./transcription-config";
import {
	dispatchTranscriptionRun,
	resumeTranscriptionDispatch,
} from "./transcription-dispatch";

type TranscribeResult = {
	success: boolean;
	message: string;
};

export type TranscribeVideoOptions = {
	/**
	 * The recording's segments are fully uploaded but post-processing (the mux
	 * into result.mp4) has not finished. Skips the active-upload guard — the
	 * upload row is in "processing" during the mux — and makes the workflow
	 * transcribe straight from the segment audio, deferring back to the normal
	 * post-mux queue if that isn't possible.
	 */
	earlyFromSegments?: boolean;
};

const TRANSCRIPTION_ALREADY_HANDLED_MESSAGE =
	"Transcription already completed, in progress, or awaiting manual retry";

/** How recently a live-transcription claim must have been stamped to defer
 * to it. Chunks stamp every ~10s; 3 minutes tolerates long retries without
 * letting a dead workflow block transcription forever. */
const LIVE_CLAIM_FRESHNESS_MS = 3 * 60 * 1000;

export async function transcribeVideo(
	videoId: Video.VideoId,
	userId: string,
	aiGenerationEnabled = false,
	options: TranscribeVideoOptions = {},
): Promise<TranscribeResult> {
	if (!isTranscriptionConfigured(serverEnv())) {
		return {
			success: false,
			message: "Missing necessary environment variables",
		};
	}

	if (!userId || !videoId) {
		return {
			success: false,
			message: "userId or videoId not supplied",
		};
	}

	const query = await db()
		.select({
			video: videos,
			settings: videos.settings,
			orgSettings: organizations.settings,
		})
		.from(videos)
		.leftJoin(organizations, eq(videos.orgId, organizations.id))
		.where(eq(videos.id, videoId));

	if (query.length === 0) {
		return { success: false, message: "Video does not exist" };
	}

	const result = query[0];
	if (!result || !result.video) {
		return { success: false, message: "Video information is missing" };
	}

	const { video } = result;
	if (video.ownerId !== userId)
		return { success: false, message: "Video owner does not match" };
	if (
		video.transcriptionStatus === "PROCESSING" &&
		video.metadata?.transcriptionRun &&
		video.metadata.transcriptionRun.dispatch !== "accepted"
	) {
		const run = video.metadata.transcriptionRun;
		const resumed = await resumeTranscriptionDispatch(videoId, run);
		if (
			!resumed &&
			!run.workflowRunId &&
			Date.now() - Date.parse(run.requestedAt) > 5 * 60 * 1000 &&
			(await releaseTranscriptionRun(db(), {
				videoId,
				ownerId: video.ownerId,
				runId: run.id,
			}))
		)
			return transcribeVideo(videoId, userId, aiGenerationEnabled, options);
	}

	if (
		video.transcriptionStatus === "COMPLETE" ||
		video.transcriptionStatus === "PROCESSING" ||
		video.transcriptionStatus === "SKIPPED" ||
		video.transcriptionStatus === "NO_AUDIO" ||
		video.transcriptionStatus === "ERROR"
	) {
		return {
			success: true,
			message: TRANSCRIPTION_ALREADY_HANDLED_MESSAGE,
		};
	}

	// A live transcription that is provably still running (its claim is
	// freshness-stamped every chunk) is seconds away from promoting itself to
	// canonical; claiming now would race it and transcribe the same audio
	// twice. A stale stamp means the workflow died - proceed normally. The
	// live workflow's own full-pass fallback uses earlyFromSegments, which is
	// exempt so it can never deadlock against its opener.
	if (!options.earlyFromSegments && process.env.CAP_RUNTIME !== "cloudflare") {
		const live = video.metadata?.liveTranscript;
		const stampedAt = live?.updatedAt ? Date.parse(live.updatedAt) : Number.NaN;
		if (
			live?.status === "active" &&
			Number.isFinite(stampedAt) &&
			Date.now() - stampedAt < LIVE_CLAIM_FRESHNESS_MS
		) {
			return {
				success: true,
				message: "Live transcription in progress",
			};
		}
	}

	if (!options.earlyFromSegments) {
		const upload = await db()
			.select({ phase: videoUploads.phase })
			.from(videoUploads)
			.where(eq(videoUploads.videoId, videoId))
			.limit(1);

		if (
			upload[0]?.phase === "uploading" ||
			upload[0]?.phase === "processing" ||
			upload[0]?.phase === "generating_thumbnail"
		) {
			return {
				success: true,
				message: "Video upload is still in progress",
			};
		}
	}

	try {
		const claimed = await claimTranscriptionRun(
			db(),
			videoId,
			video.ownerId,
			options,
		);
		if (!claimed)
			return {
				success: true,
				message:
					(video.settings?.disableTranscript ??
					result.orgSettings?.disableTranscript)
						? "Transcription disabled for video — skipping transcription"
						: TRANSCRIPTION_ALREADY_HANDLED_MESSAGE,
			};
		await dispatchTranscriptionRun(
			transcribeVideoWorkflow,
			claimed.video,
			aiGenerationEnabled,
			options.earlyFromSegments,
		);
		return { success: true, message: "Transcription workflow started" };
	} catch (error) {
		console.error("[transcribeVideo] Failed to trigger workflow:", error);
		return {
			success: false,
			message: "Failed to start transcription workflow",
		};
	}
}
