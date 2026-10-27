import { randomUUID } from "node:crypto";
import type { CloudflareDatabase } from "@cap/database/cloudflare";
import { db } from "@cap/database/cloudflare/application";
import { type AtomicStatement, atomic } from "@cap/database/cloudflare/atomic";
import {
	mediaProcessingBudgets,
	organizationMembers,
	organizations,
	videoProcessingJobs,
	videos,
	videoUploads,
} from "@cap/database/cloudflare/schema";
import { requireOwnedVideo } from "@cap/web-backend/src/Videos/persistence";
import type { User, Video } from "@cap/web-domain";
import {
	and,
	asc,
	eq,
	getTableColumns,
	gt,
	inArray,
	isNull,
	lte,
	ne,
	or,
	sql,
} from "drizzle-orm";
import { z } from "zod";
import type { DesktopRecordingSource } from "@/lib/desktop-recording-source";
import {
	type DesktopRecordingSourceCheckpoint,
	desktopRecordingSourceCheckpointSchema,
} from "@/lib/desktop-recording-source-checkpoint";
import {
	type RecordingVerification,
	recordingVerificationSchema,
} from "@/lib/desktop-recording-verification";
import {
	RECORDING_PROCESSING_ATTEMPTS,
	recordingBudgetKey,
} from "@/lib/media-processing-budget";

export const activeRecordingJob = sql`exists (select 1 from ${videos} inner join ${organizations} on ${organizations.id} = ${videos.orgId} where ${videos.id} = ${videoProcessingJobs.videoId} and ${videos.ownerId} = ${videoProcessingJobs.ownerId} and ${organizations.tombstoneAt} is null and (${organizations.ownerId} = ${videos.ownerId} or exists (select 1 from ${organizationMembers} where ${organizationMembers.organizationId} = ${videos.orgId} and ${organizationMembers.userId} = ${videos.ownerId})))`;

export const DESKTOP_RECORDING_LEASE_MS = 5 * 60 * 1_000;
export const DESKTOP_RECORDING_SOURCE_RETRY_MS = 60 * 60 * 1_000;
export const DESKTOP_RECORDING_OUTPUT_REPLACED = "output-replaced";
export const DESKTOP_RECORDING_DELETING = "video-deleting";
export const DESKTOP_RECORDING_SOURCE_REUPLOAD_REQUIRED =
	"source-reupload-required";
export const DESKTOP_RECORDING_RETRY_EXHAUSTED = "processing-retry-exhausted";
const MAX_AUTOMATIC_ATTEMPTS = RECORDING_PROCESSING_ATTEMPTS;
const RETRY_EXHAUSTED_MESSAGE =
	"Processing paused after repeated failures. Your uploaded recording is retained. Please contact support.";

const sourceSchema = z.object({
	version: z.literal(1),
	kind: z.enum(["segments", "mp4"]),
	manifestSha256: z
		.string()
		.regex(/^[a-f0-9]{64}$/)
		.optional(),
	inventorySha256: z.string().regex(/^[a-f0-9]{64}$/),
	inventoryKey: z.string().min(1),
	requiredAudio: z.boolean(),
	mp4: z
		.object({
			fileSize: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
			duration: z.number().finite().positive().optional(),
			objectIdentity: z.string().min(1),
		})
		.optional(),
});

type StoredJob = typeof videoProcessingJobs.$inferSelect;

export type DesktopRecordingJob = Omit<StoredJob, "source" | "verification"> & {
	source: DesktopRecordingSource | null;
	verification: RecordingVerification | null;
};

export type DesktopRecordingAttempt = DesktopRecordingJob & {
	attemptId: string;
};

export type DesktopRecordingAttemptFence = {
	videoId: Video.VideoId;
	generation: string;
	attemptId: string;
};

export const desktopRecordingWorkerCheckpointSchema = z.object({
	version: z.literal(1),
	kind: z.literal("recording-worker"),
	generation: z.string().min(1),
	attemptId: z.string().min(1),
	jobId: z.string().min(1),
	sequence: z.number().int().nonnegative().safe(),
	phase: z.enum([
		"queued",
		"downloading",
		"probing",
		"processing",
		"uploading",
		"generating_thumbnail",
		"complete",
		"error",
		"cancelled",
	]),
	progress: z.number().finite().min(0).max(100),
	payloadSha256: z.string().regex(/^[a-f0-9]{64}$/),
	updatedAt: z.string().datetime(),
	stateChangedAt: z.string().datetime(),
});

export function getDesktopRecordingWorkerCheckpoint(job: DesktopRecordingJob) {
	const output = job.output;
	if (typeof output !== "object" || output === null) return null;
	const value =
		"kind" in output && output.kind === "recording-worker"
			? output
			: "recordingWorker" in output
				? output.recordingWorker
				: null;
	if (value === null) return null;
	const checkpoint = desktopRecordingWorkerCheckpointSchema.parse(value);
	if (
		checkpoint.generation !== job.generation ||
		checkpoint.attemptId !== job.attemptId ||
		checkpoint.jobId !== job.remoteJobId
	)
		throw new Error("Recording worker checkpoint does not match its owner");
	return checkpoint;
}

export class SourceCommitPendingError extends Error {
	readonly code = "source-commit-pending";

	constructor() {
		super(
			"Recording source is still being secured. Processing will continue automatically.",
		);
		this.name = "SourceCommitPendingError";
	}
}

export class DesktopRecordingSourceBlockedError extends Error {
	constructor(
		readonly code: string,
		message: string,
	) {
		super(message);
		this.name = "DesktopRecordingSourceBlockedError";
	}
}

export function parseDesktopRecordingJob(row: StoredJob): DesktopRecordingJob {
	return {
		...row,
		source: row.source === null ? null : sourceSchema.parse(row.source),
		verification:
			row.verification === null
				? null
				: recordingVerificationSchema.parse(row.verification),
	};
}

export function getDesktopRecordingRetryDelay(attemptCount: number) {
	return Math.min(
		15_000 * 2 ** Math.min(Math.max(attemptCount - 1, 0), 8),
		3_600_000,
	);
}

export function isDesktopRecordingJobRecoverable(
	job: DesktopRecordingJob,
	now: Date,
) {
	if (job.state === "verified") return false;
	if (job.errorCode === DESKTOP_RECORDING_SOURCE_REUPLOAD_REQUIRED)
		return false;
	if (job.errorCode === DESKTOP_RECORDING_RETRY_EXHAUSTED) return false;
	if (job.errorCode === DESKTOP_RECORDING_OUTPUT_REPLACED) return false;
	if (job.errorCode === DESKTOP_RECORDING_DELETING) return false;
	if (job.state === "source-blocked" && job.source) return false;
	if (job.leaseExpiresAt && job.leaseExpiresAt > now) return false;
	return job.nextRetryAt <= now;
}

function sameArtifact(
	verification: RecordingVerification,
	job: DesktopRecordingJob,
) {
	const previous = job.verification?.artifact;
	const incoming = verification.artifact;
	if (incoming.kind === "segments") {
		return (
			job.source?.kind !== "mp4" &&
			(job.source?.manifestSha256 ??
				job.manifestSha256 ??
				(previous?.kind === "segments" ? previous.manifestSha256 : null)) ===
				incoming.manifestSha256
		);
	}
	const mp4 = job.source?.mp4 ?? (previous?.kind === "mp4" ? previous : null);
	return (
		job.source?.kind !== "segments" &&
		mp4?.objectIdentity === incoming.objectIdentity &&
		mp4.fileSize === incoming.fileSize &&
		(mp4.duration === undefined || mp4.duration === incoming.duration)
	);
}

function newJob({
	videoId,
	userId,
	verification,
	now,
}: {
	videoId: Video.VideoId;
	userId: User.UserId;
	verification?: RecordingVerification;
	now: Date;
}): DesktopRecordingJob {
	return {
		videoId,
		ownerId: userId,
		generation: randomUUID(),
		manifestSha256:
			verification?.artifact.kind === "segments"
				? verification.artifact.manifestSha256
				: null,
		state: "committing",
		attemptId: null,
		attemptCount: 0,
		leaseExpiresAt: null,
		nextRetryAt: now,
		workflowRunId: null,
		remoteJobId: null,
		source: null,
		verification: verification ?? null,
		output: null,
		errorCode: null,
		errorMessage: null,
		createdAt: now,
		updatedAt: now,
	};
}

export async function ensureSegmentProcessingJob({
	videoId,
	userId,
	verification,
	now = new Date(),
}: {
	videoId: Video.VideoId;
	userId: User.UserId;
	verification?: RecordingVerification;
	now?: Date;
}): Promise<{ job: DesktopRecordingJob; created: boolean }> {
	const candidate = newJob({ videoId, userId, verification, now });
	const database = db();
	return atomic<{ job: DesktopRecordingJob; created: boolean }>(
		database,
		async (snapshot) => {
			const statements: AtomicStatement[] = [];
			const [stored] = await snapshot.read((reader) =>
				reader
					.select()
					.from(videoProcessingJobs)
					.where(eq(videoProcessingJobs.videoId, videoId)),
			);
			const video = await requireOwnedVideo(snapshot, videoId, userId);
			if (
				video.source.type !== "desktopSegments" &&
				video.source.type !== "desktopMP4"
			) {
				throw new Error("Recording is not a desktop upload");
			}
			let job = stored ? parseDesktopRecordingJob(stored) : candidate;
			const created = !stored;
			if (job.ownerId !== userId) throw new Error("Recording owner changed");
			if (created)
				statements.push(database.insert(videoProcessingJobs).values(candidate));
			if (job.errorCode === DESKTOP_RECORDING_DELETING) {
				throw new DesktopRecordingSourceBlockedError(
					DESKTOP_RECORDING_DELETING,
					"This recording is being deleted and will not be processed again.",
				);
			}
			if (job.errorCode === DESKTOP_RECORDING_OUTPUT_REPLACED) {
				throw new DesktopRecordingSourceBlockedError(
					DESKTOP_RECORDING_OUTPUT_REPLACED,
					"This recording was intentionally edited or replaced. Its original source is retained and will not replace the current video.",
				);
			}
			const replacesArtifact =
				verification !== undefined &&
				(job.source !== null || job.verification !== null) &&
				!sameArtifact(verification, job);
			const resumesReupload =
				verification !== undefined &&
				job.errorCode === DESKTOP_RECORDING_SOURCE_REUPLOAD_REQUIRED;
			if (created || replacesArtifact || resumesReupload) {
				if (replacesArtifact || resumesReupload) {
					job =
						resumesReupload && !replacesArtifact && verification
							? {
									...candidate,
									verification: {
										...verification,
										requiredAudio:
											verification.requiredAudio ||
											job.verification?.requiredAudio === true ||
											job.source?.requiredAudio === true,
									},
								}
							: candidate;
					statements.push(
						database
							.update(videoProcessingJobs)
							.set(job)
							.where(
								and(
									activeRecordingJob,
									eq(videoProcessingJobs.videoId, videoId),
								),
							),
					);
				}
				const upload = {
					phase: "processing" as const,
					processingProgress: 0,
					processingMessage: "Securing recording source...",
					processingError: null,
					updatedAt: now,
				};
				statements.push(
					database
						.insert(videoUploads)
						.values({ videoId, ...upload })
						.onConflictDoUpdate({ target: videoUploads.videoId, set: upload }),
				);
				return { statements, result: { job, created: true } };
			}
			if (job.ownerId !== userId) throw new Error("Recording owner changed");
			if (verification) {
				const needsReverification =
					job.state === "verified" &&
					((verification.artifact.kind === "mp4" && !job.verification) ||
						(verification.requiredAudio && !job.verification?.requiredAudio));
				const mergedVerification = {
					...verification,
					requiredAudio:
						verification.requiredAudio ||
						job.verification?.requiredAudio === true,
				};
				job = { ...job, verification: mergedVerification, updatedAt: now };
				statements.push(
					database
						.update(videoProcessingJobs)
						.set({ verification: mergedVerification, updatedAt: now })
						.where(
							and(activeRecordingJob, eq(videoProcessingJobs.videoId, videoId)),
						),
				);
				if (needsReverification) {
					job = {
						...job,
						state: "retry",
						leaseExpiresAt: null,
						nextRetryAt: now,
						workflowRunId: null,
					};
					statements.push(
						database
							.update(videoProcessingJobs)
							.set(job)
							.where(
								and(
									activeRecordingJob,
									eq(videoProcessingJobs.videoId, videoId),
								),
							),
					);
				}
			}
			if (
				job.state === "source-blocked" &&
				!job.source &&
				job.errorCode !== DESKTOP_RECORDING_RETRY_EXHAUSTED
			) {
				job = {
					...job,
					state: "committing",
					output: null,
					leaseExpiresAt: null,
					nextRetryAt: now,
					workflowRunId: null,
					errorCode: null,
					errorMessage: null,
					updatedAt: now,
				};
				statements.push(
					database
						.update(videoProcessingJobs)
						.set(job)
						.where(
							and(activeRecordingJob, eq(videoProcessingJobs.videoId, videoId)),
						),
				);
			}
			return { statements, result: { job, created: false } };
		},
	);
}

export async function getProcessingState({
	videoId,
	generation,
}: {
	videoId: Video.VideoId;
	generation?: string;
}): Promise<DesktopRecordingJob | null> {
	const [row] = await db()
		.select()
		.from(videoProcessingJobs)
		.where(
			and(
				activeRecordingJob,
				and(
					eq(videoProcessingJobs.videoId, videoId),
					generation
						? eq(videoProcessingJobs.generation, generation)
						: undefined,
				),
			),
		)
		.limit(1);
	return row ? parseDesktopRecordingJob(row) : null;
}

function pauseExhaustedRecording(
	database: CloudflareDatabase,
	videoId: Video.VideoId,
	errorMessage: string,
	now: Date,
): AtomicStatement[] {
	return [
		database
			.update(videoProcessingJobs)
			.set({
				state: "source-blocked",
				leaseExpiresAt: null,
				errorCode: DESKTOP_RECORDING_RETRY_EXHAUSTED,
				errorMessage,
				updatedAt: now,
			})
			.where(and(activeRecordingJob, eq(videoProcessingJobs.videoId, videoId))),
		database
			.update(videoUploads)
			.set({
				phase: "error",
				processingMessage: RETRY_EXHAUSTED_MESSAGE,
				processingError: RETRY_EXHAUSTED_MESSAGE,
				updatedAt: now,
			})
			.where(eq(videoUploads.videoId, videoId)),
	];
}

// A caller that names its attempts by number gets its own live attempt back on a retry instead of being
// locked out by its lease, and its next claim gets the next number's id.
export async function claimProcessingAttempt({
	videoId,
	generation,
	attemptIdFor,
	now = new Date(),
}: {
	videoId: Video.VideoId;
	generation: string;
	attemptIdFor?: (attemptCount: number) => string;
	now?: Date;
}): Promise<DesktopRecordingAttempt | null> {
	const fallbackAttemptId = randomUUID();
	const namedAttempts = attemptIdFor
		? Array.from({ length: MAX_AUTOMATIC_ATTEMPTS + 1 }, (_, count) =>
				attemptIdFor(count),
			)
		: undefined;
	const database = db();
	return atomic(database, async (snapshot) => {
		const statements: AtomicStatement[] = [];
		const [row] = await snapshot.read((reader) =>
			reader
				.select()
				.from(videoProcessingJobs)
				.where(
					and(
						activeRecordingJob,
						and(
							eq(videoProcessingJobs.videoId, videoId),
							eq(videoProcessingJobs.generation, generation),
						),
					),
				),
		);
		if (!row) return { statements, result: null };
		const job = parseDesktopRecordingJob(row);
		const ownAttemptId =
			namedAttempts !== undefined &&
			job.attemptId === namedAttempts[job.attemptCount]
				? job.attemptId
				: null;
		if (
			ownAttemptId !== null &&
			job.leaseExpiresAt &&
			job.leaseExpiresAt > now &&
			(job.state === "committing" ||
				job.state === "queued" ||
				job.state === "processing")
		)
			return { statements, result: { ...job, attemptId: ownAttemptId } };
		if (!isDesktopRecordingJobRecoverable(job, now))
			return { statements, result: null };
		if (job.attemptCount >= MAX_AUTOMATIC_ATTEMPTS) {
			statements.push(
				...pauseExhaustedRecording(
					database,
					videoId,
					job.errorMessage ?? "Automatic processing attempt limit reached.",
					now,
				),
			);
			return { statements, result: null };
		}
		const attempt: DesktopRecordingAttempt = {
			...job,
			state: job.source ? "processing" : "committing",
			attemptId: namedAttempts?.[job.attemptCount + 1] ?? fallbackAttemptId,
			attemptCount: job.attemptCount + 1,
			leaseExpiresAt: new Date(now.getTime() + DESKTOP_RECORDING_LEASE_MS),
			remoteJobId: null,
			output: job.source ? null : job.output,
			errorCode: null,
			errorMessage: null,
			updatedAt: now,
		};
		statements.push(
			database
				.update(videoProcessingJobs)
				.set(attempt)
				.where(
					and(activeRecordingJob, eq(videoProcessingJobs.videoId, videoId)),
				),
		);
		const upload = {
			phase: "processing" as const,
			processingProgress: 0,
			processingMessage: job.source
				? "Verifying and processing recording..."
				: "Securing recording source...",
			processingError: null,
			updatedAt: now,
		};
		statements.push(
			database
				.insert(videoUploads)
				.values({ videoId, ...upload })
				.onConflictDoUpdate({ target: videoUploads.videoId, set: upload }),
		);
		return { statements, result: attempt };
	});
}

function attemptCondition(fence: DesktopRecordingAttemptFence) {
	return and(
		eq(videoProcessingJobs.videoId, fence.videoId),
		eq(videoProcessingJobs.generation, fence.generation),
		eq(videoProcessingJobs.attemptId, fence.attemptId),
		inArray(videoProcessingJobs.state, ["committing", "queued", "processing"]),
	);
}

export async function initializeSourceCommitCheckpoint(
	fence: DesktopRecordingAttemptFence,
): Promise<DesktopRecordingSourceCheckpoint | null> {
	const now = new Date();
	const snapshotId = randomUUID();
	const database = db();
	return atomic(database, async (snapshot) => {
		const statements: AtomicStatement[] = [];
		const [row] = await snapshot.read((reader) =>
			reader
				.select()
				.from(videoProcessingJobs)
				.where(
					and(
						activeRecordingJob,
						and(attemptCondition(fence), isNull(videoProcessingJobs.source)),
					),
				),
		);
		if (!row || !row.leaseExpiresAt || row.leaseExpiresAt <= now)
			return { statements, result: null };
		if (row.output !== null) {
			const checkpoint = desktopRecordingSourceCheckpointSchema.parse(
				row.output,
			);
			if (checkpoint.generation !== fence.generation)
				return { statements, result: null };
			return { statements, result: checkpoint };
		}
		const checkpoint: DesktopRecordingSourceCheckpoint = {
			kind: "desktop-recording-source-commit",
			version: 1,
			generation: fence.generation,
			snapshotId,
			revision: 0,
			phase: "plan",
			cursor: 0,
			planRoots: [],
			receiptRoots: [],
		};
		statements.push(
			database
				.update(videoProcessingJobs)
				.set({ output: checkpoint, updatedAt: now })
				.where(and(activeRecordingJob, attemptCondition(fence))),
		);
		return { statements, result: checkpoint };
	});
}

export async function persistSourceCommitCheckpoint(
	fence: DesktopRecordingAttemptFence,
	checkpoint: DesktopRecordingSourceCheckpoint,
): Promise<boolean> {
	const parsed = desktopRecordingSourceCheckpointSchema.parse(checkpoint);
	if (parsed.generation !== fence.generation) return false;
	const now = new Date();
	const database = db();
	return atomic(database, async (snapshot) => {
		const statements: AtomicStatement[] = [];
		const [row] = await snapshot.read((reader) =>
			reader
				.select()
				.from(videoProcessingJobs)
				.where(
					and(
						activeRecordingJob,
						and(attemptCondition(fence), isNull(videoProcessingJobs.source)),
					),
				),
		);
		if (!row || !row.leaseExpiresAt || row.leaseExpiresAt <= now)
			return { statements, result: false };
		const previous = desktopRecordingSourceCheckpointSchema.parse(row.output);
		if (
			previous.generation !== parsed.generation ||
			previous.snapshotId !== parsed.snapshotId ||
			previous.revision + 1 !== parsed.revision
		)
			return { statements, result: false };
		statements.push(
			database
				.update(videoProcessingJobs)
				.set({
					output: parsed,
					leaseExpiresAt: new Date(now.getTime() + DESKTOP_RECORDING_LEASE_MS),
					updatedAt: now,
				})
				.where(and(activeRecordingJob, attemptCondition(fence))),
		);
		return { statements, result: true };
	});
}

export async function persistCommittedSource(
	fence: DesktopRecordingAttemptFence,
	source: DesktopRecordingSource,
): Promise<boolean> {
	const parsedInput = sourceSchema.parse(source);
	const now = new Date();
	const database = db();
	return atomic(database, async (snapshot) => {
		const statements: AtomicStatement[] = [];
		let parsed = parsedInput;
		const [row] = await snapshot.read((reader) =>
			reader
				.select()
				.from(videoProcessingJobs)
				.where(and(activeRecordingJob, attemptCondition(fence))),
		);
		if (!row || !row.leaseExpiresAt || row.leaseExpiresAt <= now)
			return { statements, result: false };
		const current = parseDesktopRecordingJob(row);
		if (current.source) {
			return {
				statements,
				result: current.source.inventorySha256 === parsed.inventorySha256,
			};
		}
		const verification = current.verification;
		if (
			verification &&
			(!sameArtifact(verification, { ...current, source: parsed }) ||
				(parsed.kind === "segments" &&
					verification.requiredAudio &&
					!parsed.requiredAudio))
		) {
			statements.push(
				database
					.update(videoProcessingJobs)
					.set({
						state: "retry",
						output: null,
						leaseExpiresAt: null,
						nextRetryAt: new Date(
							now.getTime() + getDesktopRecordingRetryDelay(1),
						),
						errorCode: "source-intent-changed",
						errorMessage:
							"The completed upload changed while its source was being secured. Retrying its snapshot.",
						updatedAt: now,
					})
					.where(and(activeRecordingJob, attemptCondition(fence))),
			);
			return { statements, result: false };
		}
		if (
			parsed.kind === "mp4" &&
			parsed.mp4 &&
			verification?.artifact.kind === "mp4"
		) {
			parsed = {
				...parsed,
				requiredAudio: parsed.requiredAudio || verification.requiredAudio,
				mp4: { ...parsed.mp4, duration: verification.artifact.duration },
			};
		}
		statements.push(
			database
				.update(videoProcessingJobs)
				.set({
					source: parsed,
					output: null,
					manifestSha256: parsed.manifestSha256 ?? null,
					state: "processing",
					leaseExpiresAt: new Date(now.getTime() + DESKTOP_RECORDING_LEASE_MS),
					updatedAt: now,
				})
				.where(and(activeRecordingJob, attemptCondition(fence))),
		);
		return { statements, result: true };
	});
}

export async function attachRemoteJob({
	remoteJobId,
	...fence
}: DesktopRecordingAttemptFence & { remoteJobId: string }): Promise<boolean> {
	const now = new Date();
	const result = await db()
		.update(videoProcessingJobs)
		.set({ remoteJobId, updatedAt: now })
		.where(
			and(
				activeRecordingJob,
				and(
					attemptCondition(fence),
					gt(videoProcessingJobs.leaseExpiresAt, now),
					or(
						isNull(videoProcessingJobs.remoteJobId),
						eq(videoProcessingJobs.remoteJobId, remoteJobId),
					),
				),
			),
		);
	return result.meta.changes > 0;
}

export async function heartbeatAttempt({
	now = new Date(),
	...fence
}: DesktopRecordingAttemptFence & { now?: Date }): Promise<boolean> {
	const database = db();
	return atomic(database, async (snapshot) => {
		const statements: AtomicStatement[] = [];
		const [row] = await snapshot.read((reader) =>
			reader
				.select()
				.from(videoProcessingJobs)
				.where(and(activeRecordingJob, attemptCondition(fence))),
		);
		if (
			!row ||
			!row.leaseExpiresAt ||
			row.leaseExpiresAt <= now ||
			getDesktopRecordingWorkerCheckpoint(parseDesktopRecordingJob(row))
		)
			return { statements, result: false };
		statements.push(
			database
				.update(videoProcessingJobs)
				.set({
					leaseExpiresAt: new Date(now.getTime() + DESKTOP_RECORDING_LEASE_MS),
					updatedAt: now,
				})
				.where(and(activeRecordingJob, attemptCondition(fence))),
		);
		return { statements, result: true };
	});
}

export async function waitForDesktopRecordingCapacity({
	now = new Date(),
	retryAfterMs,
	...fence
}: DesktopRecordingAttemptFence & {
	now?: Date;
	retryAfterMs: number;
}): Promise<boolean> {
	if (
		!Number.isSafeInteger(retryAfterMs) ||
		retryAfterMs <= 0 ||
		retryAfterMs > 360_000
	)
		throw new Error("Invalid capacity retry delay");
	const database = db();
	return atomic(database, async (snapshot) => {
		const statements: AtomicStatement[] = [];
		const condition = and(
			attemptCondition(fence),
			isNull(videoProcessingJobs.remoteJobId),
			gt(videoProcessingJobs.leaseExpiresAt, now),
		);
		const [row] = await snapshot.read((reader) =>
			reader
				.select()
				.from(videoProcessingJobs)
				.where(and(activeRecordingJob, condition)),
		);
		if (
			!row ||
			getDesktopRecordingWorkerCheckpoint(parseDesktopRecordingJob(row))
		)
			return { statements, result: false };
		const nextRetryAt = new Date(now.getTime() + retryAfterMs);
		statements.push(
			database
				.update(videoProcessingJobs)
				.set({
					leaseExpiresAt: new Date(
						nextRetryAt.getTime() + DESKTOP_RECORDING_LEASE_MS,
					),
					nextRetryAt,
					output: {
						kind: "desktop-recording-capacity-wait",
						version: 1,
						retryAt: nextRetryAt.toISOString(),
					},
					updatedAt: now,
				})
				.where(and(activeRecordingJob, condition)),
		);
		statements.push(
			database
				.update(videoUploads)
				.set({
					phase: "processing",
					processingMessage:
						"Waiting for a processing slot. Your recording is safely stored.",
					processingError: null,
					updatedAt: now,
				})
				.where(eq(videoUploads.videoId, fence.videoId)),
		);
		return { statements, result: true };
	});
}

export async function scheduleRetry({
	errorCode,
	errorMessage,
	now = new Date(),
	nextRetryAt,
	...fence
}: DesktopRecordingAttemptFence & {
	errorCode: string;
	errorMessage: string;
	now?: Date;
	nextRetryAt?: Date;
}): Promise<boolean> {
	const database = db();
	return atomic(database, async (snapshot) => {
		const statements: AtomicStatement[] = [];
		const [row] = await snapshot.read((reader) =>
			reader
				.select({ attemptCount: videoProcessingJobs.attemptCount })
				.from(videoProcessingJobs)
				.where(and(activeRecordingJob, attemptCondition(fence))),
		);
		if (!row) return { statements, result: false };
		if (row.attemptCount >= MAX_AUTOMATIC_ATTEMPTS) {
			statements.push(
				...pauseExhaustedRecording(
					database,
					fence.videoId,
					`${errorCode}: ${errorMessage}`,
					now,
				),
			);
			return { statements, result: true };
		}
		statements.push(
			database
				.update(videoProcessingJobs)
				.set({
					state: "retry",
					leaseExpiresAt: null,
					nextRetryAt:
						nextRetryAt ??
						new Date(
							now.getTime() + getDesktopRecordingRetryDelay(row.attemptCount),
						),
					errorCode,
					errorMessage,
					updatedAt: now,
				})
				.where(and(activeRecordingJob, attemptCondition(fence))),
		);
		statements.push(
			database
				.update(videoUploads)
				.set({
					phase: "processing",
					processingMessage:
						"Processing interrupted. Retrying automatically...",
					processingError: null,
					updatedAt: now,
				})
				.where(eq(videoUploads.videoId, fence.videoId)),
		);
		return { statements, result: true };
	});
}

export async function markSourceBlocked({
	errorCode,
	errorMessage,
	now = new Date(),
	...fence
}: DesktopRecordingAttemptFence & {
	errorCode: string;
	errorMessage: string;
	now?: Date;
}): Promise<boolean> {
	const database = db();
	return atomic(database, async (snapshot) => {
		const statements: AtomicStatement[] = [];
		const [current] = await snapshot.read((reader) =>
			reader
				.select()
				.from(videoProcessingJobs)
				.where(and(activeRecordingJob, attemptCondition(fence))),
		);
		if (!current) return { statements, result: false };
		statements.push(
			database
				.update(videoProcessingJobs)
				.set({
					state: "source-blocked",
					leaseExpiresAt: null,
					nextRetryAt: new Date(
						now.getTime() + DESKTOP_RECORDING_SOURCE_RETRY_MS,
					),
					errorCode,
					errorMessage,
					updatedAt: now,
				})
				.where(and(activeRecordingJob, attemptCondition(fence))),
		);
		statements.push(
			database
				.update(videoUploads)
				.set({
					phase: "error",
					processingMessage:
						"Waiting for complete recording source. Uploaded files are retained.",
					processingError: `${errorCode}: ${errorMessage}`,
					updatedAt: now,
				})
				.where(eq(videoUploads.videoId, fence.videoId)),
		);
		return { statements, result: true };
	});
}

export async function attachWorkflowRun({
	videoId,
	generation,
	workflowRunId,
}: {
	videoId: Video.VideoId;
	generation: string;
	workflowRunId: string;
}): Promise<void> {
	await db()
		.update(videoProcessingJobs)
		.set({ workflowRunId })
		.where(
			and(
				activeRecordingJob,
				and(
					eq(videoProcessingJobs.videoId, videoId),
					eq(videoProcessingJobs.generation, generation),
				),
			),
		);
}

export async function recordWorkflowDispatchFailure({
	videoId,
	generation,
	errorMessage,
	now = new Date(),
}: {
	videoId: Video.VideoId;
	generation: string;
	errorMessage: string;
	now?: Date;
}): Promise<void> {
	await db()
		.update(videoProcessingJobs)
		.set({
			workflowRunId: null,
			nextRetryAt: new Date(now.getTime() + getDesktopRecordingRetryDelay(1)),
			errorCode: "workflow-dispatch-failed",
			errorMessage,
			updatedAt: now,
		})
		.where(
			and(
				activeRecordingJob,
				and(
					eq(videoProcessingJobs.videoId, videoId),
					eq(videoProcessingJobs.generation, generation),
					inArray(videoProcessingJobs.state, ["committing", "queued", "retry"]),
					or(
						isNull(videoProcessingJobs.leaseExpiresAt),
						lte(videoProcessingJobs.leaseExpiresAt, now),
					),
				),
			),
		);
}

export async function deferWithoutMediaServer(
	fence: DesktopRecordingAttemptFence,
): Promise<boolean> {
	const now = new Date();
	const database = db();
	return atomic(database, async (snapshot) => {
		const statements: AtomicStatement[] = [];
		const [current] = await snapshot.read((reader) =>
			reader
				.select()
				.from(videoProcessingJobs)
				.where(and(activeRecordingJob, attemptCondition(fence))),
		);
		if (!current) return { statements, result: false };
		statements.push(
			database
				.update(videoProcessingJobs)
				.set({
					state: "queued",
					leaseExpiresAt: null,
					nextRetryAt: new Date(
						now.getTime() + 24 * DESKTOP_RECORDING_SOURCE_RETRY_MS,
					),
					errorCode: "media-server-unconfigured",
					errorMessage:
						"Source is retained; full output verification requires a media server.",
					updatedAt: now,
				})
				.where(and(activeRecordingJob, attemptCondition(fence))),
		);
		statements.push(
			database
				.delete(videoUploads)
				.where(eq(videoUploads.videoId, fence.videoId)),
		);
		return { statements, result: true };
	});
}

// Blocked recordings whose source is committed and whose failure an operator can reasonably retry once the cause is fixed.
const OPERATOR_RETRYABLE_BLOCKS = new Set([
	"processing-budget-exhausted",
	"source-invalid",
	DESKTOP_RECORDING_RETRY_EXHAUSTED,
]);

export async function retryBlockedDesktopRecording({
	videoId,
	now = new Date(),
}: {
	videoId: Video.VideoId;
	now?: Date;
}): Promise<
	| { status: "queued"; ownerId: User.UserId; previousErrorCode: string }
	| { status: "not-found" }
	| { status: "not-retryable"; state: string; errorCode: string | null }
> {
	const generation = randomUUID();
	const database = db();
	return atomic<Awaited<ReturnType<typeof retryBlockedDesktopRecording>>>(
		database,
		async (snapshot) => {
			const statements: AtomicStatement[] = [];
			const [row] = await snapshot.read((reader) =>
				reader
					.select()
					.from(videoProcessingJobs)
					.where(
						and(activeRecordingJob, eq(videoProcessingJobs.videoId, videoId)),
					),
			);
			if (!row) return { statements, result: { status: "not-found" as const } };
			const job = parseDesktopRecordingJob(row);
			if (
				job.state !== "source-blocked" ||
				!job.source ||
				!job.errorCode ||
				!OPERATOR_RETRYABLE_BLOCKS.has(job.errorCode)
			)
				return {
					statements,
					result: {
						status: "not-retryable" as const,
						state: job.state,
						errorCode: job.errorCode,
					},
				};
			statements.push(
				database
					.update(videoProcessingJobs)
					.set({
						state: "retry",
						generation,
						attemptId: null,
						remoteJobId: null,
						output: null,
						attemptCount: 0,
						leaseExpiresAt: null,
						nextRetryAt: now,
						workflowRunId: null,
						errorCode: null,
						errorMessage: null,
						updatedAt: now,
					})
					.where(
						and(
							activeRecordingJob,
							and(
								eq(videoProcessingJobs.videoId, videoId),
								eq(videoProcessingJobs.generation, job.generation),
								eq(videoProcessingJobs.state, "source-blocked"),
							),
						),
					),
			);
			// Earlier attempts spent this generation's transfer budget; the retry starts with a fresh one.
			statements.push(
				database
					.delete(mediaProcessingBudgets)
					.where(
						eq(
							mediaProcessingBudgets.id,
							recordingBudgetKey(videoId, job.generation),
						),
					),
			);
			statements.push(
				database
					.update(videoUploads)
					.set({
						phase: "processing",
						processingProgress: 0,
						processingMessage: "Retrying video processing...",
						processingError: null,
						updatedAt: now,
					})
					.where(eq(videoUploads.videoId, videoId)),
			);
			return {
				statements,
				result: {
					status: "queued" as const,
					ownerId: job.ownerId,
					previousErrorCode: job.errorCode,
				},
			};
		},
	);
}

export function retireDesktopRecordingJobForOutputReplacement(
	database: CloudflareDatabase,
	{
		videoId,
		userId,
		now = new Date(),
	}: { videoId: Video.VideoId; userId: User.UserId; now?: Date },
) {
	const retired = {
		generation: randomUUID(),
		state: "source-blocked" as const,
		attemptId: null,
		leaseExpiresAt: null,
		nextRetryAt: now,
		workflowRunId: null,
		remoteJobId: null,
		errorCode: DESKTOP_RECORDING_OUTPUT_REPLACED,
		errorMessage:
			"Original source retained after an intentional video edit or replacement.",
		updatedAt: now,
	};
	// MP4 outputs can be original-source snapshots; preserve source and output references until whole-video deletion.
	return database
		.insert(videoProcessingJobs)
		.values({ ...newJob({ videoId, userId, now }), ...retired })
		.onConflictDoUpdate({ target: videoProcessingJobs.videoId, set: retired });
}

export async function listRecoverableSegmentJobs({
	now = new Date(),
	limit = 20,
}: {
	now?: Date;
	limit?: number;
} = {}): Promise<DesktopRecordingJob[]> {
	const batchSize = Math.max(1, Math.min(limit, 100));
	const candidates = async (
		states: DesktopRecordingJob["state"][],
		candidateLimit: number,
		byLease = false,
	) =>
		db()
			.select(getTableColumns(videoProcessingJobs))
			.from(videoProcessingJobs)
			.innerJoin(videos, eq(videos.id, videoProcessingJobs.videoId))
			.where(
				and(
					activeRecordingJob,
					and(
						inArray(videoProcessingJobs.state, states),
						or(
							ne(videoProcessingJobs.state, "source-blocked"),
							isNull(videoProcessingJobs.source),
						),
						or(
							isNull(videoProcessingJobs.errorCode),
							and(
								ne(
									videoProcessingJobs.errorCode,
									DESKTOP_RECORDING_OUTPUT_REPLACED,
								),
								ne(videoProcessingJobs.errorCode, DESKTOP_RECORDING_DELETING),
								ne(
									videoProcessingJobs.errorCode,
									DESKTOP_RECORDING_SOURCE_REUPLOAD_REQUIRED,
								),
								ne(
									videoProcessingJobs.errorCode,
									DESKTOP_RECORDING_RETRY_EXHAUSTED,
								),
							),
						),
						lte(videoProcessingJobs.nextRetryAt, now),
						or(
							isNull(videoProcessingJobs.leaseExpiresAt),
							lte(videoProcessingJobs.leaseExpiresAt, now),
						),
					),
				),
			)
			.orderBy(
				asc(
					byLease
						? videoProcessingJobs.leaseExpiresAt
						: videoProcessingJobs.nextRetryAt,
				),
				asc(videoProcessingJobs.videoId),
			)
			.limit(candidateLimit);
	const pending = await candidates(
		["committing", "queued", "retry"],
		batchSize,
	);
	const expired = await candidates(["processing"], batchSize, true);
	const active = [...pending, ...expired]
		.map(parseDesktopRecordingJob)
		.filter((job) => isDesktopRecordingJobRecoverable(job, now))
		.sort((left, right) => {
			const leftDue = left.leaseExpiresAt ?? left.nextRetryAt;
			const rightDue = right.leaseExpiresAt ?? right.nextRetryAt;
			return (
				leftDue.getTime() - rightDue.getTime() ||
				left.videoId.localeCompare(right.videoId)
			);
		})
		.slice(0, batchSize);
	if (active.length === batchSize) return active;
	const blocked = await candidates(
		["source-blocked"],
		batchSize - active.length,
	);
	return [
		...active,
		...blocked
			.map(parseDesktopRecordingJob)
			.filter((job) => isDesktopRecordingJobRecoverable(job, now)),
	];
}
