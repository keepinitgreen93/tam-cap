import { isCrossSiteCookieWrite } from "@cap/database/auth/request-site";
import { getCurrentUser } from "@cap/database/auth/session";
import { db } from "@cap/database/cloudflare/application";
import { atomic } from "@cap/database/cloudflare/atomic";
import { videos } from "@cap/database/cloudflare/schema";
import { writableVideo } from "@cap/web-backend/src/Videos/persistence";
import { Video } from "@cap/web-domain";
import { and, eq } from "drizzle-orm";
import type { NextRequest } from "next/server";
import { z } from "zod";

const serverMetadataKeys = new Set([
	"agentUpload",
	"processingRun",
	"editProcessing",
	"editTranscriptBackfill",
	"completedVideoEdit",
	"desktopRecordingUpload",
	"loomImportRun",
	"loomImportUpload",
	"loomDeferredProcessing",
	"loomPreviewGif",
	"liveTranscript",
	"aiGenerationStatus",
	"enhancedAudioStatus",
	"transcribeOnView",
	"__proto__",
	"constructor",
	"prototype",
]);
const isServerMetadataKey = (key: string) =>
	serverMetadataKeys.has(key) ||
	key.startsWith("transcript") ||
	key.startsWith("loom");

const clientMetadataSchema = z
	.object({
		customCreatedAt: z
			.string()
			.refine((value) => Number.isFinite(Date.parse(value)))
			.optional(),
		sourceName: z.string().optional(),
		aiTitle: z.string().optional(),
		titleManuallyEdited: z.boolean().optional(),
		summary: z.string().optional(),
		summaryManuallyEdited: z.boolean().optional(),
		chapters: z
			.array(
				z.object({
					title: z.string(),
					start: z.number().finite().nonnegative(),
				}),
			)
			.optional(),
		chaptersManuallyEdited: z.boolean().optional(),
	})
	.passthrough();

export async function PUT(request: NextRequest) {
	const user = isCrossSiteCookieWrite(request) ? null : await getCurrentUser();
	const input: unknown = await request.json();
	if (
		!user ||
		!input ||
		typeof input !== "object" ||
		!("videoId" in input) ||
		!("metadata" in input) ||
		!input.videoId ||
		!input.metadata
	)
		return Response.json({ error: true }, { status: 401 });
	if (
		typeof input.videoId !== "string" ||
		typeof input.metadata !== "object" ||
		Array.isArray(input.metadata)
	)
		return Response.json({ error: true }, { status: 400 });
	const videoId = Video.VideoId.make(input.videoId);
	const parsed = clientMetadataSchema.safeParse(
		Object.fromEntries(
			Object.entries(input.metadata).filter(
				([key]) => !isServerMetadataKey(key),
			),
		),
	);
	if (!parsed.success) return Response.json({ error: true }, { status: 400 });
	const clientMetadata = parsed.data;
	const database = db();
	const updated = await atomic(database, async (snapshot) => {
		const [locked] = await snapshot.read((reader) =>
			reader
				.select({ metadata: videos.metadata })
				.from(videos)
				.where(
					and(
						writableVideo,
						eq(videos.id, videoId),
						eq(videos.ownerId, user.id),
					),
				)
				.limit(1),
		);
		if (!locked) return { statements: [], result: false };
		const protectedMetadata = { ...locked.metadata };
		for (const key of Object.keys(protectedMetadata))
			if (!isServerMetadataKey(key))
				Reflect.deleteProperty(protectedMetadata, key);
		return {
			statements: [
				database
					.update(videos)
					.set({ metadata: { ...clientMetadata, ...protectedMetadata } })
					.where(eq(videos.id, videoId)),
			],
			result: true,
		};
	});
	return updated
		? Response.json(true, { status: 200 })
		: Response.json({ error: true }, { status: 401 });
}
