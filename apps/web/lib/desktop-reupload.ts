import {
	CloudFrontClient,
	CreateInvalidationCommand,
} from "@aws-sdk/client-cloudfront";
import type { AtomicSnapshot } from "@cap/database/cloudflare/atomic";
import { videos, videoUploads } from "@cap/database/cloudflare/schema";
import type { TranscriptPublication } from "@cap/database/cloudflare/transcript-publication";
import { serverEnv } from "@cap/env";
import { AwsCredentials } from "@cap/web-backend";
import { writableVideo } from "@cap/web-backend/src/Videos/persistence";
import type { Video } from "@cap/web-domain";
import { and, eq } from "drizzle-orm";
import { Effect, Option } from "effect";
import {
	assertDesktopReuploadTarget,
	type DesktopReuploadToken,
} from "@/lib/desktop-reupload-token";
import { runPromise } from "@/lib/server";

type ReuploadedVideo = Pick<
	Video.Video,
	"id" | "ownerId" | "bucketId" | "storageIntegrationId"
>;

export async function prepareDesktopReupload(
	snapshot: AtomicSnapshot,
	video: ReuploadedVideo,
	token: DesktopReuploadToken,
	transcriptPublication: TranscriptPublication,
) {
	const [locked] = await snapshot.read((reader) =>
		reader
			.select()
			.from(videos)
			.where(and(writableVideo, eq(videos.id, video.id))),
	);
	if (
		!locked ||
		locked.id !== video.id ||
		locked.ownerId !== video.ownerId ||
		locked.bucket !== Option.getOrNull(video.bucketId) ||
		locked.storageIntegrationId !== Option.getOrNull(video.storageIntegrationId)
	) {
		throw new Error("Recording storage changed during reupload");
	}
	assertDesktopReuploadTarget(
		token,
		{ ...video, source: locked.source },
		`${video.ownerId}/${video.id}/result.mp4`,
	);
	if (
		(locked.source.type === "desktopMP4" || locked.source.type === "webMP4") &&
		locked.source.outputKey === token.outputKey
	) {
		return null;
	}
	const [upload] = await snapshot.read((reader) =>
		reader
			.select({ rawFileKey: videoUploads.rawFileKey })
			.from(videoUploads)
			.where(eq(videoUploads.videoId, video.id)),
	);
	if (upload?.rawFileKey !== token.outputKey) {
		throw new Error("Replacement upload was canceled or superseded");
	}

	const metadata = { ...(locked.metadata ?? {}) };
	delete metadata.desktopRecordingUpload;
	delete metadata.summary;
	delete metadata.chapters;
	delete metadata.aiGenerationStatus;
	delete metadata.transcriptionRun;
	delete metadata.editTranscriptBackfill;
	delete metadata.liveTranscript;
	delete metadata.processingRun;
	metadata.transcriptPublication = transcriptPublication;
	Reflect.deleteProperty(metadata, "editProcessing");
	Reflect.deleteProperty(metadata, "completedVideoEdit");
	return {
		source:
			locked.source.type === "webMP4"
				? { type: "webMP4" as const, outputKey: token.outputKey }
				: { type: "desktopMP4" as const, outputKey: token.outputKey },
		metadata,
		transcriptionStatus: null,
	};
}

export async function invalidateReuploadedVideo(video: ReuploadedVideo) {
	if (
		Option.isSome(video.bucketId) ||
		Option.isSome(video.storageIntegrationId)
	)
		return;
	const distributionId = serverEnv().CAP_CLOUDFRONT_DISTRIBUTION_ID;
	if (!distributionId) return;
	const client = new CloudFrontClient({
		region: serverEnv().CAP_AWS_REGION || "us-east-1",
		credentials: await runPromise(
			Effect.map(AwsCredentials, (value) => value.credentials),
		),
	});
	try {
		await client.send(
			new CreateInvalidationCommand({
				DistributionId: distributionId,
				InvalidationBatch: {
					CallerReference: crypto.randomUUID(),
					Paths: { Quantity: 1, Items: [`/${video.ownerId}/${video.id}/*`] },
				},
			}),
		);
	} finally {
		client.destroy();
	}
}
