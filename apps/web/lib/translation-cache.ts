import { createHash } from "node:crypto";
import {
	getTranscriptPublication,
	type TranscriptVideo,
	transcriptMediaRevision,
} from "@cap/database/cloudflare/transcript-publication";

export function translationCachePrefix(video: TranscriptVideo, vtt: string) {
	const publication = getTranscriptPublication(video);
	const revision = createHash("sha256").update(vtt).digest("hex");
	return `${video.ownerId}/${video.id}/.translations/${publication?.id ?? "legacy"}/${revision}/transcription.`;
}

export function isSameTranscriptSource(
	expected: TranscriptVideo,
	current: TranscriptVideo | undefined,
) {
	return (
		current !== undefined &&
		transcriptMediaRevision(current) === transcriptMediaRevision(expected) &&
		getTranscriptPublication(current)?.id ===
			getTranscriptPublication(expected)?.id
	);
}
