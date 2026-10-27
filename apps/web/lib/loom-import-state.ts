import type { CloudflareDatabase } from "@cap/database/cloudflare";
import { requireActiveOrganization } from "@cap/database/cloudflare/access";
import { type AtomicSnapshot, atomic } from "@cap/database/cloudflare/atomic";
import {
	videoEdits,
	videos,
	videoUploads,
} from "@cap/database/cloudflare/schema";
import { transcriptMediaRevision } from "@cap/database/cloudflare/transcript-publication";
import type { VideoMetadata } from "@cap/database/types";
import { Video } from "@cap/web-domain";
import { eq } from "drizzle-orm";
import { currentLoomImportArtifactKeys } from "./loom-import-artifacts";

export type LoomImportIdentity = {
	videoId: string;
	userId: string;
	bucketId: string | null;
	rawFileKey: string;
};
export type LoomImportRun = NonNullable<VideoMetadata["loomImportRun"]>;

export function loomImportMediaRevision(video: typeof videos.$inferSelect) {
	const metadata = { ...video.metadata };
	delete metadata.transcriptionRun;
	return transcriptMediaRevision({ ...video, metadata });
}

export function ownsLoomImportSource(
	video: typeof videos.$inferSelect,
	runId: string,
) {
	const run = video.metadata?.loomImportRun;
	if (run?.runId !== runId) return false;
	if (!run.sourceRevision) return process.env.CAP_RUNTIME !== "cloudflare";
	const identity = run.sourceIdentity;
	if (
		!identity ||
		identity.ownerId !== video.ownerId ||
		identity.organizationId !== video.orgId ||
		identity.bucketId !== video.bucket ||
		identity.storageIntegrationId !== video.storageIntegrationId
	)
		return false;
	const keys = currentLoomImportArtifactKeys(video);
	return (
		loomImportMediaRevision(video) === run.sourceRevision ||
		Boolean(
			keys &&
				"outputKey" in video.source &&
				video.source.outputKey === keys.outputKey,
		)
	);
}

export async function readLoomImportVideo(
	snapshot: AtomicSnapshot,
	identity: LoomImportIdentity,
) {
	const id = Video.VideoId.make(identity.videoId);
	const [video] = await snapshot.read((reader) =>
		reader.select().from(videos).where(eq(videos.id, id)).limit(1),
	);
	if (
		!video ||
		video.ownerId !== identity.userId ||
		video.bucket !== identity.bucketId ||
		video.isScreenshot ||
		!identity.rawFileKey.startsWith(`${video.ownerId}/${video.id}/`) ||
		identity.rawFileKey.includes("..")
	)
		throw new Error("Loom import ownership or storage changed");
	if (video.orgId) await requireActiveOrganization(snapshot, video.orgId);
	const [edit] = await snapshot.read((reader) =>
		reader
			.select({ id: videoEdits.videoId })
			.from(videoEdits)
			.where(eq(videoEdits.videoId, id))
			.limit(1),
	);
	if (
		edit ||
		video.metadata?.editProcessing ||
		["queued", "processing"].includes(
			video.metadata?.processingRun?.state ?? "",
		)
	)
		throw new Error("Loom import was replaced by another media operation");
	return video;
}

export async function writeLoomImportReceipt(
	database: CloudflareDatabase,
	identity: LoomImportIdentity,
	receipt: LoomImportRun,
	expectedRunId?: string | null,
) {
	return atomic(database, async (snapshot) => {
		const video = await readLoomImportVideo(snapshot, identity);
		const current = video.metadata?.loomImportRun;
		if (receipt.dispatch === "pending") {
			if ((current?.runId ?? null) !== (expectedRunId ?? null))
				return { statements: [], result: false };
			const [upload] = await snapshot.read((reader) =>
				reader
					.select()
					.from(videoUploads)
					.where(eq(videoUploads.videoId, video.id))
					.limit(1),
			);
			if (
				!upload ||
				!["uploading", "processing", "error"].includes(upload.phase)
			)
				return { statements: [], result: false };
		} else if (!ownsLoomImportSource(video, receipt.runId))
			return { statements: [], result: false };
		const metadata = { ...video.metadata };
		if (receipt.dispatch === "pending") {
			delete metadata.processingRun;
			if (current?.runId !== receipt.runId) delete metadata.loomImportUpload;
			metadata.loomImportRun = {
				...receipt,
				sourceIdentity: {
					ownerId: video.ownerId,
					organizationId: video.orgId,
					bucketId: video.bucket,
					storageIntegrationId: video.storageIntegrationId,
				},
				sourceRevision: loomImportMediaRevision({ ...video, metadata }),
			};
		} else metadata.loomImportRun = { ...current, ...receipt };
		return {
			statements: [
				database
					.update(videos)
					.set({ metadata })
					.where(eq(videos.id, video.id)),
			],
			result: true,
		};
	});
}

export async function ensureLoomImportWorkflow(
	database: CloudflareDatabase,
	identity: LoomImportIdentity,
	runId: string,
) {
	const [existing] = await database
		.select()
		.from(videos)
		.where(eq(videos.id, Video.VideoId.make(identity.videoId)))
		.limit(1);
	if (!existing) throw new Error("Loom import no longer exists");
	if (!existing.metadata?.loomImportRun) {
		if (
			!(await writeLoomImportReceipt(
				database,
				identity,
				{ runId, dispatch: "pending" },
				null,
			))
		)
			throw new Error("Loom import startup was replaced");
		if (
			!(await writeLoomImportReceipt(database, identity, {
				runId,
				dispatch: "accepted",
			}))
		)
			throw new Error("Loom import startup was replaced");
	}
	return atomic(database, async (snapshot) => {
		const video = await readLoomImportVideo(snapshot, identity);
		if (!ownsLoomImportSource(video, runId))
			throw new Error("Loom import run was superseded");
		return { statements: [], result: video };
	});
}
