import { db } from "@cap/database/cloudflare/application";
import type { videos, videoUploads } from "@cap/database/cloudflare/schema";
import { serverEnv } from "@cap/env";
import { makeCurrentUserLayer, Videos } from "@cap/web-backend";
import { createVideo } from "@cap/web-backend/src/Videos/persistence";
import { Video } from "@cap/web-domain";
import { Effect, Option } from "effect";
import { runPromise } from "@/lib/server";

export async function createRecordingUpload<T>({
	user,
	value,
	initialUpload,
	upload,
}: {
	user: Parameters<typeof makeCurrentUserLayer>[0];
	value: typeof videos.$inferInsert;
	initialUpload?: Omit<typeof videoUploads.$inferInsert, "videoId">;
	upload: (video: Video.Video) => Promise<T>;
}) {
	const now = new Date();
	await createVideo(
		db(),
		{ ...value, createdAt: now, updatedAt: now },
		{ initialUpload, defaultPublic: serverEnv().CAP_VIDEOS_DEFAULT_PUBLIC },
	);
	const video = Video.Video.make({
		id: value.id,
		ownerId: value.ownerId,
		orgId: value.orgId,
		name: value.name ?? "My Video",
		public: value.public ?? false,
		source: value.source ?? { type: "webMP4" },
		metadata: Option.fromNullable(value.metadata),
		bucketId: Option.fromNullable(value.bucket),
		storageIntegrationId: Option.fromNullable(value.storageIntegrationId),
		folderId: Option.fromNullable(value.folderId),
		width: Option.fromNullable(value.width),
		height: Option.fromNullable(value.height),
		duration: Option.fromNullable(value.duration),
		transcriptionStatus: Option.fromNullable(value.transcriptionStatus),
		createdAt: now,
		updatedAt: now,
	});
	try {
		return await upload(video);
	} catch (error) {
		try {
			await Effect.flatMap(Videos, (service) => service.delete(video.id)).pipe(
				Effect.provide(makeCurrentUserLayer(user)),
				runPromise,
			);
		} catch (cleanupError) {
			console.error("Unpublished recording cleanup did not finish", {
				videoId: video.id,
				cleanupError,
			});
		}
		throw error;
	}
}
