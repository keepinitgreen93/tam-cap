import {
	CloudFrontClient,
	CreateInvalidationCommand,
} from "@aws-sdk/client-cloudfront";
import {
	type CloudflareDatabase,
	updateIfDefined,
} from "@cap/database/cloudflare";
import type { AtomicSnapshot } from "@cap/database/cloudflare/atomic";
import {
	videoEdits,
	videos,
	videoUploads,
} from "@cap/database/cloudflare/schema";
import type { TranscriptPublication } from "@cap/database/cloudflare/transcript-publication";
import { createTranscriptInvalidation } from "@cap/database/cloudflare/transcript-publication";
import { serverEnv } from "@cap/env";
import { AwsCredentials, Storage } from "@cap/web-backend";
import { writableVideo } from "@cap/web-backend/src/Videos/persistence";
import type { Video } from "@cap/web-domain";
import { and, eq } from "drizzle-orm";
import { Effect, Option } from "effect";
import { z } from "zod";
import {
	assertDesktopReuploadTarget,
	type DesktopReuploadToken,
} from "@/lib/desktop-reupload-token";
import { runPromise } from "@/lib/server";
import { normalizeVideoFps } from "@/lib/video-metadata";
import { retireDesktopRecordingJobForOutputReplacement } from "./desktop-recording-jobs";
import { ownedRecordingPlan } from "./recording-upload-state";
import { decodeStorageVideo } from "./video-storage";

type ReuploadedVideo = Pick<
	Video.Video,
	"id" | "ownerId" | "bucketId" | "storageIntegrationId"
>;

export class ReplacementMetadataVerificationError extends Error {
	constructor() {
		super(
			"The replacement video could not be verified. Upload it again or retry.",
		);
		this.name = "ReplacementMetadataVerificationError";
	}
}

const replacementProbeSchema = z.object({
	metadata: z.object({
		duration: z.number().finite().positive(),
		width: z.number().finite().positive().nullish(),
		height: z.number().finite().positive().nullish(),
		fps: z.number().finite().positive().nullish(),
	}),
});

async function probeReplacement(
	database: CloudflareDatabase,
	video: ReuploadedVideo,
	token: DesktopReuploadToken,
) {
	const [current] = await database
		.select()
		.from(videos)
		.where(
			and(
				writableVideo,
				eq(videos.id, video.id),
				eq(videos.ownerId, video.ownerId),
			),
		);
	if (
		!current ||
		current.bucket !== Option.getOrNull(video.bucketId) ||
		current.storageIntegrationId !==
			Option.getOrNull(video.storageIntegrationId)
	)
		throw Error("Recording storage changed during reupload");
	assertDesktopReuploadTarget(
		token,
		{ ...video, source: current.source },
		`${video.ownerId}/${video.id}/result.mp4`,
	);
	if (
		(current.source.type === "webMP4" ||
			current.source.type === "desktopMP4") &&
		current.source.outputKey === token.outputKey
	)
		return null;
	try {
		const env = serverEnv();
		if (!env.MEDIA_SERVER_URL) throw new ReplacementMetadataVerificationError();
		const [bucket] = await Storage.getAccessForVideo(
			decodeStorageVideo(current),
			{ resolvePublishedOutput: false },
		).pipe(runPromise);
		const videoUrl = await bucket
			.getInternalSignedObjectUrl(token.outputKey, { expiresIn: 300 })
			.pipe(runPromise);
		const response = await fetch(
			`${env.MEDIA_SERVER_URL.replace(/\/$/, "")}/video/probe`,
			{
				method: "POST",
				headers: {
					"Content-Type": "application/json",
					"x-media-server-secret": env.MEDIA_SERVER_WEBHOOK_SECRET ?? "",
				},
				body: JSON.stringify({ videoUrl }),
				signal: AbortSignal.timeout(30_000),
			},
		);
		const parsed = replacementProbeSchema.safeParse(await response.json());
		if (!response.ok || !parsed.success)
			throw new ReplacementMetadataVerificationError();
		return {
			duration: parsed.data.metadata.duration,
			width: parsed.data.metadata.width
				? Math.round(parsed.data.metadata.width)
				: undefined,
			height: parsed.data.metadata.height
				? Math.round(parsed.data.metadata.height)
				: undefined,
			fps: parsed.data.metadata.fps
				? Math.max(1, Math.round(parsed.data.metadata.fps))
				: undefined,
		};
	} catch {
		throw new ReplacementMetadataVerificationError();
	}
}

export async function prepareDesktopReupload(
	snapshot: AtomicSnapshot,
	video: ReuploadedVideo,
	token: DesktopReuploadToken,
	transcriptPublication: TranscriptPublication,
	duration?: number,
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
	delete metadata.aiGenerationRun;
	delete metadata.summaryManuallyEdited;
	delete metadata.chaptersManuallyEdited;
	delete metadata.enhancedAudioStatus;
	delete metadata.loomImportRun;
	delete metadata.loomImportUpload;
	delete metadata.loomDeferredProcessing;
	delete metadata.loomPreviewGif;
	delete metadata.transcribeOnView;
	delete metadata.agentUpload;
	delete metadata.loomReassignClaim;
	delete metadata.transcriptionRun;
	delete metadata.editTranscriptBackfill;
	delete metadata.liveTranscript;
	delete metadata.processingRun;
	metadata.transcriptPublication = transcriptPublication;
	metadata.editingBase = {
		version: 1,
		id: transcriptPublication.id,
		sourceKey: token.outputKey,
		duration:
			typeof duration === "number" && Number.isFinite(duration) && duration > 0
				? duration
				: null,
	};
	Reflect.deleteProperty(metadata, "editProcessing");
	Reflect.deleteProperty(metadata, "completedVideoEdit");
	return {
		source:
			locked.source.type === "webMP4"
				? { type: "webMP4" as const, outputKey: token.outputKey }
				: { type: "desktopMP4" as const, outputKey: token.outputKey },
		metadata,
		transcriptionStatus: null,
		isScreenshot: false,
	};
}

export async function publishDesktopReupload(
	database: CloudflareDatabase,
	video: ReuploadedVideo,
	token: DesktopReuploadToken,
	dimensions: {
		duration?: number;
		width?: number;
		height?: number;
		fps?: number;
	} = {},
	authorize?: (snapshot: AtomicSnapshot) => Promise<void>,
) {
	let replacementDimensions = dimensions;
	if (
		!dimensions.duration ||
		!Number.isFinite(dimensions.duration) ||
		dimensions.duration <= 0
	) {
		try {
			replacementDimensions = {
				...dimensions,
				...(await probeReplacement(database, video, token)),
			};
		} catch (error) {
			if (error instanceof ReplacementMetadataVerificationError)
				await ownedRecordingPlan(database, video, async (snapshot, current) => {
					assertDesktopReuploadTarget(
						token,
						{ ...video, source: current.source },
						`${video.ownerId}/${video.id}/result.mp4`,
					);
					if (
						(current.source.type === "webMP4" ||
							current.source.type === "desktopMP4") &&
						current.source.outputKey === token.outputKey
					)
						return { statements: [], result: undefined };
					const [upload] = await snapshot.read((reader) =>
						reader
							.select()
							.from(videoUploads)
							.where(eq(videoUploads.videoId, video.id))
							.limit(1),
					);
					return {
						statements:
							upload?.rawFileKey === token.outputKey
								? [
										database
											.delete(videoUploads)
											.where(eq(videoUploads.videoId, video.id)),
									]
								: [],
						result: undefined,
					};
				}).catch(() => undefined);
			throw error;
		}
	}
	const transcriptPublication = createTranscriptInvalidation();
	const retirement = retireDesktopRecordingJobForOutputReplacement(database, {
		videoId: video.id,
		userId: video.ownerId,
	});
	return ownedRecordingPlan(database, video, async (snapshot) => {
		await authorize?.(snapshot);
		const publication = await prepareDesktopReupload(
			snapshot,
			video,
			token,
			transcriptPublication,
			replacementDimensions.duration,
		);
		if (!publication) return { statements: [], result: false };
		return {
			statements: [
				retirement,
				database
					.update(videos)
					.set({
						...publication,
						duration: updateIfDefined(
							replacementDimensions.duration,
							videos.duration,
						),
						width: updateIfDefined(replacementDimensions.width, videos.width),
						height: updateIfDefined(
							replacementDimensions.height,
							videos.height,
						),
						fps: updateIfDefined(
							normalizeVideoFps(replacementDimensions.fps),
							videos.fps,
						),
					})
					.where(
						and(eq(videos.id, video.id), eq(videos.ownerId, video.ownerId)),
					),
				database.delete(videoEdits).where(eq(videoEdits.videoId, video.id)),
				database
					.delete(videoUploads)
					.where(
						and(
							eq(videoUploads.videoId, video.id),
							eq(videoUploads.rawFileKey, token.outputKey),
						),
					),
			],
			result: true,
		};
	});
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
