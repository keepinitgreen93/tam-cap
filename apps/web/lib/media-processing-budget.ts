import { createHash } from "node:crypto";
import { db } from "@cap/database/cloudflare/application";
import { type AtomicStatement, atomic } from "@cap/database/cloudflare/atomic";
import {
	mediaProcessingBudgets,
	videoProcessingJobs,
} from "@cap/database/cloudflare/schema";
import { requireOwnedVideo } from "@cap/web-backend/src/Videos/persistence";
import { Video } from "@cap/web-domain";
import { eq, inArray, lt } from "drizzle-orm";

const MiB = 1024 ** 2;
export class MediaProcessingBudgetError extends Error {
	constructor(readonly scope: "recording") {
		super(`Recording processing paused: ${scope} transfer budget exhausted`);
		this.name = "MediaProcessingBudgetError";
	}
}
const key = (parts: string[]) =>
	createHash("sha256").update(JSON.stringify(parts)).digest("hex");

export const recordingBudgetKey = (videoId: string, generation: string) =>
	key(["recording", videoId, generation]);

// A recording's transfer budget covers every automatic attempt, so the attempt limit (not the
// budget) decides when processing stops. Media workers read sources in-region, so retries cost time, not egress.
export const RECORDING_PROCESSING_ATTEMPTS = 5;

export function getMediaProcessingReservation(sourceBytes: number) {
	if (
		!Number.isSafeInteger(sourceBytes) ||
		sourceBytes <= 0 ||
		sourceBytes > Number.MAX_SAFE_INTEGER / 20
	)
		throw new Error("Invalid processing source size");
	const attemptBytes = sourceBytes * 3 + 16 * MiB;
	return {
		attemptBytes,
		recordingBytes: attemptBytes * RECORDING_PROCESSING_ATTEMPTS,
	};
}

export async function reserveMediaProcessingBudget(input: {
	videoId: string;
	generation: string;
	attemptId: string;
	sourceBytes: number;
	purpose?: "recording" | "audio-level";
	now?: Date;
}) {
	const now = input.now ?? new Date();
	const { attemptBytes, recordingBytes } = getMediaProcessingReservation(
		input.sourceBytes,
	);
	const attemptKey = key([
		"attempt",
		input.videoId,
		input.generation,
		input.attemptId,
	]);
	const recordingKey = recordingBudgetKey(input.videoId, input.generation);
	const expiresAt = new Date(now.getTime() + 30 * 24 * 60 * 60_000);
	const database = db();
	return atomic(database, async (snapshot) => {
		const videoId = Video.VideoId.make(input.videoId);
		await requireOwnedVideo(snapshot, videoId);
		const [job] = await snapshot.read((reader) =>
			reader
				.select()
				.from(videoProcessingJobs)
				.where(eq(videoProcessingJobs.videoId, videoId))
				.limit(1),
		);
		if (
			input.purpose !== "audio-level" &&
			(!job ||
				job.generation !== input.generation ||
				job.attemptId !== input.attemptId ||
				!job.leaseExpiresAt ||
				job.leaseExpiresAt <= now ||
				!["processing", "committing", "queued"].includes(job.state))
		)
			throw new Error("Processing attempt is no longer current");
		if (job?.errorCode === "video-deleting")
			throw new Error("Recording is being deleted");
		const limits = [
			{ id: attemptKey, limitBytes: attemptBytes },
			{ id: recordingKey, limitBytes: recordingBytes },
		];
		const existing = await snapshot.read((reader) =>
			reader
				.select()
				.from(mediaProcessingBudgets)
				.where(
					inArray(
						mediaProcessingBudgets.id,
						limits.map((limit) => limit.id),
					),
				),
		);
		const rows = new Map(existing.map((row) => [row.id, row]));
		const attempt = rows.get(attemptKey);
		if (
			attempt?.reservedBytes &&
			(attempt.reservedBytes !== attemptBytes ||
				attempt.limitBytes !== attemptBytes)
		)
			throw new Error("Processing reservation changed");
		const recording = rows.get(recordingKey);
		const alreadyReserved = Boolean(attempt?.reservedBytes && recording);
		if (
			!alreadyReserved &&
			(recording?.reservedBytes ?? 0) + attemptBytes >
				(recording?.limitBytes ?? recordingBytes)
		)
			throw new MediaProcessingBudgetError("recording");
		const statements: AtomicStatement[] = limits.map((limit) => {
			const previous = rows.get(limit.id);
			const reservedBytes =
				(previous?.reservedBytes ?? 0) +
				(alreadyReserved || (limit.id === attemptKey && previous?.reservedBytes)
					? 0
					: attemptBytes);
			const deadline =
				previous && previous.expiresAt > expiresAt
					? previous.expiresAt
					: expiresAt;
			return database
				.insert(mediaProcessingBudgets)
				.values({ ...limit, reservedBytes, expiresAt: deadline })
				.onConflictDoUpdate({
					target: mediaProcessingBudgets.id,
					set: { reservedBytes, expiresAt: deadline },
				});
		});
		return { statements, result: attemptBytes };
	});
}

export async function cleanupExpiredMediaProcessingBudgets(now = new Date()) {
	const database = db();
	const expired = database
		.select({ id: mediaProcessingBudgets.id })
		.from(mediaProcessingBudgets)
		.where(lt(mediaProcessingBudgets.expiresAt, now))
		.limit(1_000);
	const result = await database
		.delete(mediaProcessingBudgets)
		.where(inArray(mediaProcessingBudgets.id, expired));
	return result.meta.changes;
}
