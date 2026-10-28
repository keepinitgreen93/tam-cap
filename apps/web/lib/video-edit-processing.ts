import type { VideoMetadata } from "@cap/database/types";
import { getVideoEditingBase } from "./video-editing-base";
import { isVideoStorageKey } from "./video-storage-key";

export function getEditSourceKey(
	ownerId: string,
	videoId: string,
	metadata?: VideoMetadata | null,
) {
	return (
		getVideoEditingBase({ id: videoId, ownerId, metadata })?.sourceKey ??
		`${ownerId}/${videoId}/source/original.mp4`
	);
}

export function isEditSourceKey({
	ownerId,
	videoId,
	rawFileKey,
	metadata,
}: {
	ownerId: string;
	videoId: string;
	rawFileKey: string | null | undefined;
	metadata?: VideoMetadata | null;
}) {
	return (
		rawFileKey === getEditSourceKey(ownerId, videoId, metadata) ||
		Boolean(
			rawFileKey &&
				metadata?.editProcessing?.ownerId === ownerId &&
				metadata.editProcessing.sourceKey === rawFileKey &&
				isVideoStorageKey({ ownerId, id: videoId }, rawFileKey),
		)
	);
}
