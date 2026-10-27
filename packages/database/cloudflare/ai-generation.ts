import { randomUUID } from "node:crypto";
import type { Video } from "@cap/web-domain";
import { eq } from "drizzle-orm";
import type { VideoMetadata } from "../types/metadata.ts";
import { requireActiveOrganization } from "./access.ts";
import { atomic } from "./atomic.ts";
import type { CloudflareDatabase } from "./index.ts";
import { videos } from "./schema.ts";
import {
	getTranscriptPublication,
	transcriptMediaRevision,
} from "./transcript-publication.ts";

export type AiGenerationRun = NonNullable<VideoMetadata["aiGenerationRun"]>;
export const LEGACY_AI_SUMMARY_FALLBACK =
	"The AI was unable to generate a proper summary for this content.";

export function ownsAiGeneration(
	video: typeof videos.$inferSelect,
	runId: string,
) {
	const run = video.metadata?.aiGenerationRun;
	return (
		run?.id === runId &&
		video.transcriptionStatus === "COMPLETE" &&
		run.mediaRevision === transcriptMediaRevision(video) &&
		run.transcriptId === (getTranscriptPublication(video)?.id ?? null)
	);
}

export async function claimAiGeneration(
	database: CloudflareDatabase,
	videoId: Video.VideoId,
	ownerId: string,
) {
	const id = randomUUID();
	const now = new Date();
	return atomic(database, async (snapshot) => {
		const [video] = await snapshot.read((reader) =>
			reader.select().from(videos).where(eq(videos.id, videoId)).limit(1),
		);
		if (!video || video.ownerId !== ownerId)
			return { statements: [], result: { state: "missing" as const } };
		if (video.orgId) await requireActiveOrganization(snapshot, video.orgId);
		if (video.transcriptionStatus !== "COMPLETE")
			return { statements: [], result: { state: "not-ready" as const } };
		const metadata = video.metadata ?? {};
		const run = metadata.aiGenerationRun;
		const current = run && ownsAiGeneration(video, run.id);
		const pendingWithoutReceiptExpired =
			run?.dispatch === "pending" &&
			!run.workflowRunId &&
			(!Number.isFinite(Date.parse(run.requestedAt)) ||
				now.getTime() - Date.parse(run.requestedAt) > 5 * 60 * 1000);
		if (
			current &&
			["PROCESSING", "QUEUED"].includes(metadata.aiGenerationStatus ?? "") &&
			run.dispatch !== "rejected" &&
			!pendingWithoutReceiptExpired
		)
			return {
				statements: [],
				result: { state: "in-progress" as const, video, run },
			};
		if (
			(current || !run) &&
			metadata.aiGenerationStatus === "COMPLETE" &&
			metadata.summary &&
			metadata.summary !== LEGACY_AI_SUMMARY_FALLBACK &&
			metadata.chapters
		)
			return { statements: [], result: { state: "complete" as const } };
		const nextRun: AiGenerationRun = {
			id,
			requestedAt: now.toISOString(),
			mediaRevision: transcriptMediaRevision(video),
			transcriptId: getTranscriptPublication(video)?.id ?? null,
			dispatch: "pending",
		};
		const next = {
			...video,
			metadata: {
				...metadata,
				aiGenerationRun: nextRun,
				aiGenerationStatus: "QUEUED" as const,
			},
		};
		return {
			statements: [
				database
					.update(videos)
					.set({ metadata: next.metadata })
					.where(eq(videos.id, videoId)),
			],
			result: { state: "claimed" as const, video: next, run: nextRun },
		};
	});
}

export async function updateAiGenerationRun(
	database: CloudflareDatabase,
	videoId: Video.VideoId,
	runId: string,
	patch: {
		status?: VideoMetadata["aiGenerationStatus"];
		run?: Partial<
			Omit<AiGenerationRun, "id" | "mediaRevision" | "transcriptId">
		>;
	},
) {
	return atomic(database, async (snapshot) => {
		const [video] = await snapshot.read((reader) =>
			reader.select().from(videos).where(eq(videos.id, videoId)).limit(1),
		);
		if (
			!video ||
			!ownsAiGeneration(video, runId) ||
			!video.metadata?.aiGenerationRun
		)
			return { statements: [], result: false };
		if (video.orgId) await requireActiveOrganization(snapshot, video.orgId);
		if (
			["COMPLETE", "SKIPPED", "ERROR"].includes(
				video.metadata.aiGenerationStatus ?? "",
			) &&
			patch.status
		)
			return { statements: [], result: false };
		return {
			statements: [
				database
					.update(videos)
					.set({
						metadata: {
							...video.metadata,
							...(patch.status ? { aiGenerationStatus: patch.status } : {}),
							aiGenerationRun: {
								...video.metadata.aiGenerationRun,
								...patch.run,
							},
						},
					})
					.where(eq(videos.id, videoId)),
			],
			result: true,
		};
	});
}
