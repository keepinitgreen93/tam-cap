"use server";

import { db } from "@cap/database/cloudflare/application";
import { videos } from "@cap/database/cloudflare/schema";
import { provideOptionalAuth, Storage, VideosPolicy } from "@cap/web-backend";
import { Policy, type Video } from "@cap/web-domain";
import { generateText } from "ai";
import { eq } from "drizzle-orm";
import { Effect, Exit, Option } from "effect";
import { isAiConfigured } from "@/lib/ai/provider";
import { runWithAiProviders } from "@/lib/ai/run";
import { isRateLimited, RATE_LIMIT_IDS } from "@/lib/rate-limit";
import * as EffectRuntime from "@/lib/server";
import { runPromise } from "@/lib/server";
import { readTranscriptVtt } from "@/lib/transcript-publication";
import {
	isSameTranscriptSource,
	translationCachePrefix,
} from "@/lib/translation-cache";
import { decodeStorageVideo } from "@/lib/video-storage";
import {
	type LanguageCode,
	SUPPORTED_LANGUAGES,
} from "./translation-languages";
import {
	isCompleteTranslation,
	joinTranslationChunks,
	readCachedTranslation,
	splitTranslationChunks,
	withSourceFingerprint,
} from "./translation-vtt";

interface TranslateResult {
	success: boolean;
	translatedVtt?: string;
	message: string;
}

export async function translateTranscript(
	videoId: Video.VideoId,
	targetLanguage: LanguageCode,
): Promise<TranslateResult> {
	if (!videoId || !targetLanguage) {
		return {
			success: false,
			message: "Missing required parameters",
		};
	}

	if (!SUPPORTED_LANGUAGES[targetLanguage]) {
		return {
			success: false,
			message: "Unsupported language",
		};
	}

	if (!isAiConfigured()) {
		return {
			success: false,
			message: "Translation service not configured",
		};
	}

	if (await isRateLimited(RATE_LIMIT_IDS.TRANSLATE_TRANSCRIPT)) {
		return { success: false, message: "Too many requests" };
	}

	const exit = await Effect.gen(function* () {
		const videosPolicy = yield* VideosPolicy;

		return yield* Effect.promise(() =>
			db().select({ video: videos }).from(videos).where(eq(videos.id, videoId)),
		).pipe(Policy.withPublicPolicy(videosPolicy.canView(videoId)));
	}).pipe(provideOptionalAuth, EffectRuntime.runPromiseExit);

	if (Exit.isFailure(exit)) {
		return { success: false, message: "Video not found" };
	}

	const query = exit.value;

	if (query.length === 0 || !query[0]?.video) {
		return { success: false, message: "Video not found" };
	}

	const { video } = query[0];

	if (video.transcriptionStatus !== "COMPLETE")
		return { success: false, message: "Original transcript not ready" };
	const [bucket] = await Storage.getAccessForVideo(
		decodeStorageVideo(video),
	).pipe(runPromise);
	const originalVtt = await readTranscriptVtt(video, {
		getText: async (key) =>
			Option.getOrNull(await bucket.getObject(key).pipe(runPromise)),
	});
	if (originalVtt === null)
		return { success: false, message: "Original transcript not found" };
	const translatedKey = `${translationCachePrefix(video, originalVtt)}${targetLanguage}.vtt`;
	try {
		const existing = Option.getOrNull(
			await bucket.getObject(translatedKey).pipe(runPromise),
		);
		const cachedTranslation =
			existing === null ? null : readCachedTranslation(originalVtt, existing);
		if (cachedTranslation) {
			const [current] = await db()
				.select()
				.from(videos)
				.where(eq(videos.id, videoId))
				.limit(1);
			if (!isSameTranscriptSource(video, current))
				return {
					success: false,
					message: "Transcript changed; retry translation",
				};
			return {
				success: true,
				translatedVtt: cachedTranslation,
				message: "Retrieved cached translation",
			};
		}
	} catch (error) {
		console.debug("[translateTranscript] No cached translation found:", error);
	}

	const translatedVtt = await translateVttContent(originalVtt, targetLanguage);

	if (!translatedVtt) {
		return { success: false, message: "Translation failed" };
	}

	const [current] = await db()
		.select()
		.from(videos)
		.where(eq(videos.id, videoId))
		.limit(1);
	if (!isSameTranscriptSource(video, current))
		return { success: false, message: "Transcript changed; retry translation" };
	const cacheBody = withSourceFingerprint(originalVtt, translatedVtt);
	if (cacheBody) {
		try {
			await bucket
				.putObject(translatedKey, cacheBody, { contentType: "text/vtt" })
				.pipe(runPromise);
		} catch (error) {
			console.error(
				"[translateTranscript] Failed to cache translation:",
				error,
			);
		}
	}

	return {
		success: true,
		translatedVtt,
		message: "Translation completed",
	};
}

async function translateVttContent(
	vttContent: string,
	targetLanguage: LanguageCode,
): Promise<string | null> {
	const targetLanguageName = SUPPORTED_LANGUAGES[targetLanguage];
	const chunks = splitTranslationChunks(vttContent);
	if (!chunks) return null;

	const translations: string[] = [];
	for (const chunk of chunks) {
		const prompt = `Translate the following WebVTT subtitle file to ${targetLanguageName}.

IMPORTANT RULES:
1. Keep the "WEBVTT" header exactly as is
2. Keep all timestamp lines exactly as they are (e.g., "00:00:01.234 --> 00:00:03.456")
3. Keep all cue numbers exactly as they are
4. Only translate the actual text content on each line
5. Preserve all newlines and formatting
6. Do not add any explanations or comments
7. Return ONLY the translated VTT content

VTT content to translate:

${chunk}`;

		try {
			const translatedChunk = await runWithAiProviders(
				"generation",
				async (selection) => {
					const response = await generateText({
						model: selection.model(),
						prompt,
						maxOutputTokens: 8000,
						...(selection.supportsTemperature ? { temperature: 0.3 } : {}),
					});

					if (
						response.finishReason === "length" ||
						!isCompleteTranslation(chunk, response.text)
					) {
						throw new Error("translation response has missing or changed cues");
					}

					return response.text.trim();
				},
			);
			translations.push(translatedChunk);
		} catch (error) {
			console.error("[translateVttContent] Translation error:", error);
			return null;
		}
	}

	return joinTranslationChunks(vttContent, chunks, translations);
}
