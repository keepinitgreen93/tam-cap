import { db } from "@cap/database/cloudflare/application";
import { developerVideos } from "@cap/database/cloudflare/schema";
import { buildEnv } from "@cap/env";
import { provideOptionalAuth, S3Buckets } from "@cap/web-backend";
import { zValidator } from "@hono/zod-validator";
import { and, eq, isNull } from "drizzle-orm";
import { Effect, Option } from "effect";
import { Hono } from "hono";
import { z } from "zod";
import {
	finishDeveloperUpload,
	reserveDeveloperUpload,
} from "@/lib/developer-usage";
import { runPromise } from "@/lib/server";
import { hasCompleteRecordingParts, matchesCompletedRecordingParts } from "@/lib/recording-multipart-integrity";
import { withDeveloperPublicAuth } from "../../../../utils";

const MICRO_CREDITS_PER_MINUTE = 5_000;
const MAX_DURATION_SECS = 4 * 60 * 60;

export const app = new Hono<{
	Variables: {
		developerAppId: string;
		developerKeyType: "public";
	};
}>().use(withDeveloperPublicAuth);

app.post(
	"/initiate",
	zValidator(
		"json",
		z.object({
			videoId: z.string(),
			contentType: z.string().optional(),
		}),
	),
	async (c) => {
		const appId = c.get("developerAppId");
		const { videoId, contentType } = c.req.valid("json");

		const [video] = await db()
			.select({
				id: developerVideos.id,
				appId: developerVideos.appId,
				s3Key: developerVideos.s3Key,
			})
			.from(developerVideos)
			.where(
				and(eq(developerVideos.id, videoId), isNull(developerVideos.deletedAt)),
			)
			.limit(1);

		if (!video || video.appId !== appId) {
			return c.json({ error: "Video not found" }, 404);
		}

		if (!video.s3Key) {
			return c.json({ error: "Video has no S3 key" }, 400);
		}

		const s3Key = video.s3Key;

		const ALLOWED_CONTENT_TYPES = [
			"video/mp4",
			"video/webm",
			"video/quicktime",
			"video/x-matroska",
			"video/avi",
			"application/octet-stream",
		];

		const resolvedContentType =
			contentType && ALLOWED_CONTENT_TYPES.includes(contentType)
				? contentType
				: "video/mp4";

		try {
			const uploadId = await Effect.gen(function* () {
				const [bucket] = yield* S3Buckets.getBucketAccess(Option.none());
				const { UploadId } = yield* bucket.multipart.create(s3Key, {
					ContentType: resolvedContentType,
					CacheControl: "max-age=31536000",
				});
				if (!UploadId) throw new Error("No UploadId returned");
				return UploadId;
			}).pipe(provideOptionalAuth, runPromise);

			return c.json({ uploadId });
		} catch (error) {
			console.error("Error initiating multipart upload:", error);
			return c.json({ error: "Failed to initiate upload" }, 500);
		}
	},
);

app.post(
	"/presign-part",
	zValidator(
		"json",
		z.object({
			videoId: z.string(),
			uploadId: z.string(),
			partNumber: z.number().int().min(1).max(10000),
		}),
	),
	async (c) => {
		const appId = c.get("developerAppId");
		const { videoId, uploadId, partNumber } = c.req.valid("json");

		const [video] = await db()
			.select({
				id: developerVideos.id,
				appId: developerVideos.appId,
				s3Key: developerVideos.s3Key,
			})
			.from(developerVideos)
			.where(
				and(eq(developerVideos.id, videoId), isNull(developerVideos.deletedAt)),
			)
			.limit(1);

		if (!video || video.appId !== appId) {
			return c.json({ error: "Video not found" }, 404);
		}

		if (!video.s3Key) {
			return c.json({ error: "Video has no S3 key" }, 400);
		}

		const s3Key = video.s3Key;

		try {
			const presignedUrl = await Effect.gen(function* () {
				const [bucket] = yield* S3Buckets.getBucketAccess(Option.none());
				return yield* bucket.multipart.getPresignedUploadPartUrl(
					s3Key,
					uploadId,
					partNumber,
				);
			}).pipe(provideOptionalAuth, runPromise);

			return c.json({ presignedUrl });
		} catch (error) {
			console.error("Error creating presigned URL:", error);
			return c.json({ error: "Failed to create presigned URL" }, 500);
		}
	},
);

app.post(
	"/complete",
	zValidator(
		"json",
		z.object({
			videoId: z.string(),
			uploadId: z.string(),
			parts: z.array(
				z.object({
					partNumber: z.number().int().min(1).max(10000),
					etag: z.string(),
					size: z.number().nonnegative(),
				}),
			),
			durationInSecs: z.number().positive(),
			width: z.number().optional(),
			height: z.number().optional(),
			fps: z.number().optional(),
		}),
	),
	async (c) => {
		const appId = c.get("developerAppId");
		const { videoId, uploadId, parts, durationInSecs, width, height, fps } =
			c.req.valid("json");

		if (!hasCompleteRecordingParts(parts)) return c.json({error:"Invalid multipart manifest"},400);
		const clampedDuration = Math.min(durationInSecs, MAX_DURATION_SECS);

		const [video] = await db()
			.select({
				id: developerVideos.id,
				appId: developerVideos.appId,
				s3Key: developerVideos.s3Key,
			})
			.from(developerVideos)
			.where(
				and(eq(developerVideos.id, videoId), isNull(developerVideos.deletedAt)),
			)
			.limit(1);

		if (!video || video.appId !== appId) {
			return c.json({ error: "Video not found" }, 404);
		}

		if (!video.s3Key) {
			return c.json({ error: "Video has no S3 key" }, 400);
		}

		const s3Key = video.s3Key;

		try {
			const totalBytes = parts.reduce((sum, p) => sum + p.size, 0);
			const sizeBasedMinDuration = totalBytes / 2_500_000;
			const billingDuration = Math.min(
				Math.max(clampedDuration, sizeBasedMinDuration),
				MAX_DURATION_SECS,
			);
			const durationMinutes = billingDuration / 60;
			const microCreditsToDebit =
				buildEnv.NEXT_PUBLIC_IS_CAP === "true"
					? Math.floor(durationMinutes * MICRO_CREDITS_PER_MINUTE)
					: 0;

			const reservation = await reserveDeveloperUpload(db(), {
				appId,
				videoId,
				uploadId,
				amount: microCreditsToDebit,
				durationSeconds: billingDuration,
				totalBytes,
			});
			if (reservation === "missing")
				return c.json({ error: "Credit account or video not found" }, 404);
			if (reservation === "insufficient")
				return c.json({ error: "Insufficient credits" }, 402);
			if (reservation === "conflict")
				return c.json(
					{ error: "Upload does not match the reserved completion" },
					409,
				);
			if (reservation === "complete") return c.json({ success: true });

			await Effect.gen(function* () {
				const [bucket] = yield* S3Buckets.getBucketAccess(Option.none());

				const sortedParts = [...parts].sort(
					(a, b) => a.partNumber - b.partNumber,
				);
				const formattedParts = sortedParts.map((part) => ({
					PartNumber: part.partNumber,
					ETag: part.etag,
				}));

				yield* bucket.multipart.complete(s3Key,uploadId,{MultipartUpload:{Parts:formattedParts}}).pipe(Effect.catchAll((error)=>bucket.headObject(s3Key).pipe(Effect.flatMap((head)=>matchesCompletedRecordingParts(head,parts)?Effect.void:Effect.fail(error)))));
			}).pipe(provideOptionalAuth, runPromise);

			await finishDeveloperUpload(db(), {
				appId,
				videoId,
				uploadId,
				duration: clampedDuration,
				width,
				height,
				fps,
			});

			return c.json({ success: true });
		} catch (error) {
			console.error("Error completing multipart upload:", error);
			return c.json({ error: "Failed to complete upload" }, 500);
		}
	},
);

app.post(
	"/abort",
	zValidator(
		"json",
		z.object({
			videoId: z.string(),
			uploadId: z.string(),
		}),
	),
	async (c) => {
		const appId = c.get("developerAppId");
		const { videoId, uploadId } = c.req.valid("json");

		const [video] = await db()
			.select({
				id: developerVideos.id,
				appId: developerVideos.appId,
				s3Key: developerVideos.s3Key,
			})
			.from(developerVideos)
			.where(
				and(eq(developerVideos.id, videoId), isNull(developerVideos.deletedAt)),
			)
			.limit(1);

		if (!video || video.appId !== appId) {
			return c.json({ error: "Video not found" }, 404);
		}

		if (!video.s3Key) {
			return c.json({ error: "Video has no S3 key" }, 400);
		}

		const s3Key = video.s3Key;

		try {
			await Effect.gen(function* () {
				const [bucket] = yield* S3Buckets.getBucketAccess(Option.none());
				yield* bucket.multipart.abort(s3Key, uploadId);
			}).pipe(provideOptionalAuth, runPromise);

			return c.json({ success: true });
		} catch (error) {
			console.error("Error aborting multipart upload:", error);
			return c.json({ error: "Failed to abort upload" }, 500);
		}
	},
);
