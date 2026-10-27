"use server";

import { db } from "@cap/database/cloudflare/application";
import { videos } from "@cap/database/cloudflare/schema";
import { provideOptionalAuth, Storage, VideosPolicy } from "@cap/web-backend";
import { Policy, type Video } from "@cap/web-domain";
import { eq } from "drizzle-orm";
import { Effect, Exit, Option } from "effect";
import * as EffectRuntime from "@/lib/server";
import { runPromise } from "@/lib/server";
import { readTranscriptVtt } from "@/lib/transcript-publication";
import {
	isSameTranscriptSource,
	translationCachePrefix,
} from "@/lib/translation-cache";
import { decodeStorageVideo } from "@/lib/video-storage";
import {
	isLanguageCode,
	type LanguageCode,
	SUPPORTED_LANGUAGES,
} from "./translation-languages";
import { readCachedTranslation } from "./translation-vtt";

interface AvailableTranslation {
	code: LanguageCode;
	name: string;
}

interface GetAvailableTranslationsResult {
	success: boolean;
	hasOriginal: boolean;
	translations: AvailableTranslation[];
	message?: string;
}

export async function getAvailableTranslations(
	videoId: Video.VideoId,
): Promise<GetAvailableTranslationsResult> {
	if (!videoId) {
		return {
			success: false,
			hasOriginal: false,
			translations: [],
			message: "Missing video ID",
		};
	}

	const exit = await Effect.gen(function* () {
		const videosPolicy = yield* VideosPolicy;

		return yield* Effect.promise(() =>
			db().select({ video: videos }).from(videos).where(eq(videos.id, videoId)),
		).pipe(Policy.withPublicPolicy(videosPolicy.canView(videoId)));
	}).pipe(provideOptionalAuth, EffectRuntime.runPromiseExit);

	if (Exit.isFailure(exit)) {
		return {
			success: false,
			hasOriginal: false,
			translations: [],
			message: "Video not found",
		};
	}

	const query = exit.value;

	if (query.length === 0 || !query[0]?.video) {
		return {
			success: false,
			hasOriginal: false,
			translations: [],
			message: "Video not found",
		};
	}

	const { video } = query[0];

	try {
		const [bucket] = await Storage.getAccessForVideo(
			decodeStorageVideo(video),
		).pipe(runPromise);
		const original =
			video.transcriptionStatus === "COMPLETE"
				? await readTranscriptVtt(video, {
						getText: async (key) =>
							Option.getOrNull(await bucket.getObject(key).pipe(runPromise)),
					})
				: null;
		if (original === null)
			return { success: true, hasOriginal: false, translations: [] };
		const prefix = translationCachePrefix(video, original);
		const result = await bucket
			.listObjects({ prefix, maxKeys: 1000 })
			.pipe(runPromise);
		const translations: AvailableTranslation[] = [];
		for (const object of result.Contents ?? []) {
			const key = object.Key;
			if (!key?.startsWith(prefix)) continue;
			const match = key.slice(prefix.length).match(/^([a-zA-Z-]+)\.vtt$/);
			if (!match || !isLanguageCode(match[1])) continue;
			const cached = Option.getOrNull(
				await bucket.getObject(key).pipe(runPromise),
			);
			if (cached === null || readCachedTranslation(original, cached) === null)
				continue;
			translations.push({
				code: match[1],
				name: SUPPORTED_LANGUAGES[match[1]],
			});
		}
		const [current] = await db()
			.select()
			.from(videos)
			.where(eq(videos.id, videoId))
			.limit(1);
		if (!isSameTranscriptSource(video, current))
			return {
				success: false,
				hasOriginal: false,
				translations: [],
				message: "Transcript changed; retry listing translations",
			};
		const hasOriginal = true;

		return {
			success: true,
			hasOriginal,
			translations,
		};
	} catch (error) {
		console.error("[getAvailableTranslations] Error:", error);
		return {
			success: false,
			hasOriginal: false,
			translations: [],
			message: "Failed to list translations",
		};
	}
}
