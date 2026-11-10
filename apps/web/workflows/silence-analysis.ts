import { Video } from "@cap/web-domain";
import { FatalError } from "workflow";
import { analyzeVideoSilence } from "@/lib/analyze-video-silence";
import { readSilenceClaim } from "@/lib/silence-analysis-contract";
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
	const result = await analyzeVideoSilence(source);
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
