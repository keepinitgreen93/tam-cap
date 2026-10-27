import { serverEnv } from "@cap/env";
import { Video } from "@cap/web-domain";
import { FatalError, RetryableError } from "workflow";
import {
	readSilenceClaim,
	silenceAnalysisSchema,
} from "@/lib/silence-analysis-contract";
import {
	loadSilenceSource,
	readSilenceResult,
	updateSilenceClaim,
} from "@/lib/silence-analysis-storage";
import { runWorkflowPromise } from "@/lib/workflow-runtime";

type Payload = {
	videoId: string;
	ownerId: string;
	revision: string;
	requestId: string;
};

export async function silenceAnalysisWorkflow(payload: Payload) {
	"use workflow";
	try {
		await analyzeAndStore(payload);
		await finishClaim(payload, "ready");
		return { success: true };
	} catch {
		await finishClaim(payload, "error");
		return { success: false };
	}
}

async function analyzeAndStore(payload: Payload) {
	"use step";
	const videoId = Video.VideoId.make(payload.videoId);
	const source = await loadSilenceSource(videoId, payload.ownerId);
	const claim = readSilenceClaim(source.video.metadata);
	if (
		source.revision !== payload.revision ||
		claim?.requestId !== payload.requestId
	)
		throw new FatalError("Silence analysis was superseded");
	if (await readSilenceResult(source)) return;
	const env = serverEnv();
	if (!env.MEDIA_SERVER_URL || !env.MEDIA_SERVER_WEBHOOK_SECRET)
		throw new FatalError("Media processing is unavailable");
	const signal = AbortSignal.timeout(6 * 60 * 60 * 1000);
	const sourceUrl =
		source.bucket.provider === "googleDrive"
			? null
			: await source.bucket
					.getInternalSignedObjectUrl(source.key)
					.pipe(runWorkflowPromise);
	const usesR2 =
		sourceUrl !== null &&
		new URL(sourceUrl).hostname.endsWith(".r2.cloudflarestorage.com");
	let request: RequestInit & { duplex?: "half" };
	if (usesR2) {
		request = {
			method: "POST",
			headers: {
				"content-type": "application/json",
				"x-media-server-secret": env.MEDIA_SERVER_WEBHOOK_SECRET,
			},
			body: JSON.stringify({
				url: sourceUrl,
				objectPrefix: `${payload.ownerId}/${payload.videoId}/`,
				identity: source.identity,
				durationMs: source.durationMs,
				contentLength: source.contentLength,
			}),
			signal,
		};
	} else {
		let media: Response;
		if (source.bucket.provider === "googleDrive") {
			media = await source.bucket
				.getObjectResponse(source.key, null, {
					objectIdentity: source.identity,
					signal,
				})
				.pipe(runWorkflowPromise);
		} else {
			if (!sourceUrl) throw new Error("Video source is unavailable");
			media = await fetch(sourceUrl, {
				headers: { "If-Match": source.identity },
				redirect: "error",
				signal,
			});
			if (media.headers.get("etag") !== source.identity) {
				await media.body?.cancel();
				throw new Error("Video revision changed");
			}
		}
		if (!media.ok || !media.body)
			throw new Error("Video revision could not be downloaded");
		request = {
			method: "POST",
			headers: {
				"content-type": "video/mp4",
				"x-media-server-secret": env.MEDIA_SERVER_WEBHOOK_SECRET,
				"x-video-duration-ms": `${source.durationMs}`,
				"content-length": `${source.contentLength}`,
			},
			body: media.body,
			duplex: "half",
			signal,
		};
	}
	const response = await fetch(
		`${env.MEDIA_SERVER_URL}/silence-analysis`,
		request,
	);
	if (!response.ok) {
		await response.body?.cancel();
		if (response.status === 429 || response.status >= 500)
			throw new RetryableError(
				"Silence processing is temporarily unavailable",
				{ retryAfter: 30_000 },
			);
		throw new FatalError(`Silence processing failed (${response.status})`);
	}
	const result = silenceAnalysisSchema.parse(await response.json());
	if (result.durationMs !== source.durationMs)
		throw new Error("Silence result timing changed");
	const current = await loadSilenceSource(videoId, payload.ownerId);
	if (
		current.revision !== payload.revision ||
		readSilenceClaim(current.video.metadata)?.requestId !== payload.requestId
	)
		throw new FatalError("Silence analysis was superseded");
	await current.bucket
		.putObject(current.resultKey, JSON.stringify(result), {
			contentType: "application/json",
		})
		.pipe(runWorkflowPromise);
}

async function finishClaim(payload: Payload, status: "ready" | "error") {
	"use step";
	await updateSilenceClaim(
		Video.VideoId.make(payload.videoId),
		payload.ownerId,
		payload.requestId,
		{ status },
	);
}

analyzeAndStore.maxRetries = 2;
