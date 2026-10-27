import { randomUUID } from "node:crypto";
import type { User, Video } from "@cap/web-domain";
import { eq } from "drizzle-orm";
import type { TranscriptionRun } from "../types/metadata.ts";
import { requireActiveOrganization } from "./access.ts";
import { atomic } from "./atomic.ts";
import type { CloudflareDatabase } from "./index.ts";
import { videos, videoUploads } from "./schema.ts";
import {
	getTranscriptPublication,
	transcriptMediaRevision,
} from "./transcript-publication.ts";

export async function claimTranscriptionRun(
	database: CloudflareDatabase,
	videoId: Video.VideoId,
	ownerId: User.UserId,
	options: { earlyFromSegments?: boolean } = {},
) {
	const id = randomUUID();
	const now = new Date();
	return atomic(database, async (snapshot) => {
		const [video] = await snapshot.read((reader) =>
			reader.select().from(videos).where(eq(videos.id, videoId)).limit(1),
		);
		if (!video || video.ownerId !== ownerId)
			throw new Error("Video is unavailable for transcription");
		if (video.transcriptionStatus !== null)
			return { statements: [], result: null };
		const organization = video.orgId
			? await requireActiveOrganization(snapshot, video.orgId)
			: null;
		if (
			video.settings?.disableTranscript ??
			organization?.settings?.disableTranscript
		)
			return {
				statements: [
					database
						.update(videos)
						.set({ transcriptionStatus: "SKIPPED" })
						.where(eq(videos.id, videoId)),
				],
				result: null,
			};
		if (!options.earlyFromSegments) {
			const [upload] = await snapshot.read((reader) =>
				reader
					.select({ phase: videoUploads.phase })
					.from(videoUploads)
					.where(eq(videoUploads.videoId, videoId))
					.limit(1),
			);
			if (
				upload &&
				["uploading", "processing", "generating_thumbnail"].includes(
					upload.phase,
				)
			)
				return { statements: [], result: null };
		}
		const run: TranscriptionRun = {
			id,
			sourceRevision: "",
			dispatch: "pending",
			requestedAt: now.toISOString(),
		};
		const next = {
			...video,
			metadata: { ...video.metadata, transcriptionRun: run },
			transcriptionStatus: "PROCESSING" as const,
			updatedAt: now,
		};
		run.sourceRevision = transcriptMediaRevision(next);
		return {
			statements: [
				database
					.update(videos)
					.set({
						metadata: next.metadata,
						transcriptionStatus: next.transcriptionStatus,
						updatedAt: now,
					})
					.where(eq(videos.id, videoId)),
			],
			result: {
				video: next,
				organizationSettings: organization?.settings ?? null,
			},
		};
	});
}

export async function validateTranscriptionRun(
	database: CloudflareDatabase,
	videoId: Video.VideoId,
	ownerId: User.UserId,
	runId: string,
) {
	return atomic(database, async (snapshot) => {
		const [video] = await snapshot.read((reader) =>
			reader.select().from(videos).where(eq(videos.id, videoId)).limit(1),
		);
		if (
			!video ||
			video.ownerId !== ownerId ||
			video.metadata?.transcriptionRun?.id !== runId ||
			video.transcriptionStatus !== "PROCESSING"
		)
			return { statements: [], result: { state: "retired" as const } };
		const organization = video.orgId
			? await requireActiveOrganization(snapshot, video.orgId)
			: null;
		if (
			transcriptMediaRevision(video) !==
			video.metadata.transcriptionRun.sourceRevision
		)
			return { statements: [], result: { state: "source-changed" as const } };
		return {
			statements: [],
			result: {
				state: "ready" as const,
				video,
				organizationSettings: organization?.settings ?? null,
			},
		};
	});
}

export async function updateTranscriptionDispatch(
	database: CloudflareDatabase,
	videoId: Video.VideoId,
	runId: string,
	patch: Pick<TranscriptionRun, "dispatch"> &
		Partial<
			Pick<TranscriptionRun, "workflowRunId" | "workflowQueue" | "deploymentId">
		>,
) {
	return atomic(database, async (snapshot) => {
		const [video] = await snapshot.read((reader) =>
			reader.select().from(videos).where(eq(videos.id, videoId)).limit(1),
		);
		const run = video?.metadata?.transcriptionRun;
		if (!video || !run || run.id !== runId)
			return { statements: [], result: false };
		return {
			statements: [
				database
					.update(videos)
					.set({
						metadata: {
							...video.metadata,
							transcriptionRun: { ...run, ...patch },
						},
						updatedAt: video.updatedAt,
					})
					.where(eq(videos.id, videoId)),
			],
			result: true,
		};
	});
}

export async function setTranscriptionRunStatus(
	database: CloudflareDatabase,
	expected: typeof videos.$inferSelect,
	status: "SKIPPED" | "NO_AUDIO" | "ERROR" | null,
) {
	return atomic(database, async (snapshot) => {
		const [current] = await snapshot.read((reader) =>
			reader.select().from(videos).where(eq(videos.id, expected.id)).limit(1),
		);
		if (
			!current ||
			!expected.metadata?.transcriptionRun ||
			current.metadata?.transcriptionRun?.id !==
				expected.metadata.transcriptionRun.id ||
			current.transcriptionStatus !== "PROCESSING" ||
			transcriptMediaRevision(current) !== transcriptMediaRevision(expected) ||
			getTranscriptPublication(current)?.id !==
				getTranscriptPublication(expected)?.id
		)
			return { statements: [], result: false };
		const { liveTranscript: _liveTranscript, ...metadata } = current.metadata;
		return {
			statements: [
				database
					.update(videos)
					.set({ metadata, transcriptionStatus: status })
					.where(eq(videos.id, current.id)),
			],
			result: true,
		};
	});
}

export async function releaseTranscriptionRun(
	database: CloudflareDatabase,
	input: { videoId: Video.VideoId; ownerId: User.UserId; runId: string },
) {
	return atomic(database, async (snapshot) => {
		const [current] = await snapshot.read((reader) =>
			reader.select().from(videos).where(eq(videos.id, input.videoId)).limit(1),
		);
		if (
			!current ||
			current.ownerId !== input.ownerId ||
			current.metadata?.transcriptionRun?.id !== input.runId ||
			current.transcriptionStatus !== "PROCESSING"
		)
			return { statements: [], result: false };
		return {
			statements: [
				database
					.update(videos)
					.set({ transcriptionStatus: null })
					.where(eq(videos.id, current.id)),
			],
			result: true,
		};
	});
}

export function transcriptionAudioFilename(video: typeof videos.$inferSelect) {
	const id = video.metadata?.transcriptionRun?.id;
	if (
		!id ||
		!/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(
			id,
		)
	)
		throw new Error("Transcription run identity is missing");
	return `.recording/transcription/${id}/audio-temp.mp3`;
}
