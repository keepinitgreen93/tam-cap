import { createHash } from "node:crypto";
import type { videos } from "@cap/database/cloudflare/schema";
import { createTranscriptInvalidation } from "@cap/database/cloudflare/transcript-publication";
import type { VideoMetadata } from "@cap/database/types";

export function getLoomImportArtifactKeys(
	ownerId: string,
	videoId: string,
	attemptId: string,
) {
	if (
		![ownerId, videoId].every((value) => /^[A-Za-z0-9_-]{1,64}$/.test(value)) ||
		!attemptId ||
		attemptId.length > 200
	)
		throw new Error("Invalid Loom import identity");
	const canonical = `${ownerId}/${videoId}`;
	const prefix =
		process.env.CAP_RUNTIME === "cloudflare"
			? `${canonical}/.recording/outputs/loom-${createHash("sha256").update(attemptId).digest("hex")}`
			: canonical;
	return {
		outputKey: `${prefix}/result.mp4`,
		thumbnailKey:
			process.env.CAP_RUNTIME === "cloudflare"
				? `${prefix}/thumbnail.jpg`
				: `${canonical}/screenshot/screen-capture.jpg`,
		previewKey:
			process.env.CAP_RUNTIME === "cloudflare"
				? `${prefix}/preview.gif`
				: `${canonical}/preview/animated-preview.gif`,
		originalKey:
			process.env.CAP_RUNTIME === "cloudflare"
				? `${prefix}/original.webm`
				: `${canonical}/raw-upload.webm`,
	};
}

export function currentLoomImportArtifactKeys(
	video: typeof videos.$inferSelect,
) {
	const upload = video.metadata?.loomImportUpload;
	const run = video.metadata?.loomImportRun;
	const attempt = run?.mediaDispatch;
	if (
		!attempt ||
		!run ||
		!attempt.attemptId.startsWith(`${run.runId}:`) ||
		(upload &&
			(upload.attemptId !== attempt.attemptId ||
				upload.ownerId !== video.ownerId ||
				upload.organizationId !== video.orgId))
	)
		return null;
	const keys = getLoomImportArtifactKeys(
		video.ownerId,
		video.id,
		attempt.attemptId,
	);
	return !upload || upload.output.key === keys.outputKey ? keys : null;
}

export function loomImportSourcePublication(
	video: typeof videos.$inferSelect,
	metadata: VideoMetadata = video.metadata ?? {},
	duration: number | null | undefined = video.duration,
): Partial<
	Pick<
		typeof videos.$inferSelect,
		"metadata" | "source" | "transcriptionStatus"
	>
> {
	const keys = currentLoomImportArtifactKeys(video);
	if (process.env.CAP_RUNTIME !== "cloudflare" || !keys) return {};
	const nextMetadata = { ...metadata };
	const changed =
		!("outputKey" in video.source) || video.source.outputKey !== keys.outputKey;
	if (changed) {
		nextMetadata.transcriptPublication = createTranscriptInvalidation();
		nextMetadata.editingBase = {
			version: 1,
			id: nextMetadata.transcriptPublication.id,
			sourceKey: keys.outputKey,
			duration:
				typeof duration === "number" &&
				Number.isFinite(duration) &&
				duration > 0
					? duration
					: null,
		};
		delete nextMetadata.transcriptionRun;
		delete nextMetadata.editTranscriptBackfill;
		delete nextMetadata.liveTranscript;
		delete nextMetadata.aiGenerationRun;
		delete nextMetadata.aiGenerationStatus;
		delete nextMetadata.summary;
		delete nextMetadata.chapters;
		delete nextMetadata.completedVideoEdit;
	}
	return {
		metadata: nextMetadata,
		source: {
			...(changed ? {} : video.source),
			type: "webMP4" as const,
			outputKey: keys.outputKey,
			thumbnailKey: keys.thumbnailKey,
			previewKey: keys.previewKey,
		},
		...(changed ? { transcriptionStatus: null } : {}),
	};
}
