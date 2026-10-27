"use server";

import { randomUUID } from "node:crypto";
import { getCurrentUser } from "@cap/database/auth/session";
import { db } from "@cap/database/cloudflare/application";
import { atomic } from "@cap/database/cloudflare/atomic";
import { videos } from "@cap/database/cloudflare/schema";
import { userIsPro } from "@cap/utils";
import type { Video } from "@cap/web-domain";
import { eq } from "drizzle-orm";
import { getRun, start } from "workflow/api";
import {
	readSilenceClaim,
	type SilenceAnalysis,
	type SilenceClaim,
	silenceClaimIsActive,
} from "@/lib/silence-analysis-contract";
import {
	loadSilenceSource,
	readSilenceResult,
	updateSilenceClaim,
} from "@/lib/silence-analysis-storage";
import { silenceAnalysisWorkflow } from "@/workflows/silence-analysis";

async function authorizedSource(videoId: Video.VideoId) {
	const user = await getCurrentUser();
	if (!user || !userIsPro(user)) throw new Error("Unauthorized");
	return loadSilenceSource(videoId, user.id);
}

export async function getSilenceSourceRevision(videoId: Video.VideoId) {
	return (await authorizedSource(videoId)).revision;
}

type AnalysisResponse =
	| { status: "ready"; result: SilenceAnalysis; revision: string }
	| { status: "processing"; revision: string }
	| { status: "error"; message: string };

export async function getSilenceAnalysis(
	videoId: Video.VideoId,
	expectedRevision: string,
): Promise<AnalysisResponse> {
	try {
		const source = await authorizedSource(videoId);
		if (source.revision !== expectedRevision)
			return {
				status: "error",
				message: "The video changed. Reload the editor before scanning.",
			};
		const result = await readSilenceResult(source);
		if (result) return { status: "ready", result, revision: source.revision };
		const claim = readSilenceClaim(source.video.metadata);
		if (
			!claim ||
			claim.revision !== source.revision ||
			claim.status === "error"
		)
			return {
				status: "error",
				message: "Silence analysis failed. Please try again.",
			};
		if (claim.runId) {
			const status = await getRun(claim.runId).status;
			if (
				status === "failed" ||
				status === "cancelled" ||
				status === "completed"
			) {
				const completedResult = await readSilenceResult(source);
				if (completedResult)
					return {
						status: "ready",
						result: completedResult,
						revision: source.revision,
					};
				await updateSilenceClaim(
					videoId,
					source.video.ownerId,
					claim.requestId,
					{ status: "error" },
				);
				return {
					status: "error",
					message: "Silence analysis stopped. Please try again.",
				};
			}
		}
		if (!silenceClaimIsActive(claim))
			return {
				status: "error",
				message: "Silence analysis expired. Please try again.",
			};
		return { status: "processing", revision: source.revision };
	} catch {
		return {
			status: "error",
			message: "Silence analysis is unavailable. Please try again.",
		};
	}
}

export async function requestSilenceAnalysis(
	videoId: Video.VideoId,
	expectedRevision: string,
): Promise<AnalysisResponse> {
	try {
		const source = await authorizedSource(videoId);
		if (source.revision !== expectedRevision)
			return {
				status: "error",
				message: "The video changed. Reload the editor before scanning.",
			};
		const result = await readSilenceResult(source);
		if (result) return { status: "ready", result, revision: source.revision };
		const requestId = randomUUID();
		const requestedAt = Date.now();
		const claimed = await atomic(db(), async (snapshot) => {
			const [video] = await snapshot.read((database) =>
				database.select().from(videos).where(eq(videos.id, videoId)),
			);
			if (!video || video.ownerId !== source.video.ownerId)
				throw new Error("Unauthorized");
			const previous = readSilenceClaim(video.metadata);
			if (
				previous &&
				previous.revision === source.revision &&
				(silenceClaimIsActive(previous) ||
					(requestedAt >= previous.requestedAt &&
						requestedAt - previous.requestedAt < 60_000))
			)
				return { statements: [], result: false };
			const claim: SilenceClaim = {
				revision: source.revision,
				requestId,
				requestedAt,
				runId: null,
				status: "processing",
			};
			const metadata = { ...video.metadata, silenceAnalysis: claim };
			return {
				statements: [
					db().update(videos).set({ metadata }).where(eq(videos.id, videoId)),
				],
				result: true,
			};
		});
		if (claimed) {
			try {
				const run = await start(silenceAnalysisWorkflow, [
					{
						videoId,
						ownerId: source.video.ownerId,
						revision: source.revision,
						requestId,
					},
				]);
				await updateSilenceClaim(videoId, source.video.ownerId, requestId, {
					runId: run.runId,
				});
			} catch {
				return {
					status: "error",
					message:
						"Silence analysis could not confirm startup. Check again in a minute.",
				};
			}
		}
		return getSilenceAnalysis(videoId, expectedRevision);
	} catch {
		return {
			status: "error",
			message: "Silence analysis is unavailable. Please try again.",
		};
	}
}
