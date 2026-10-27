import { serverEnv } from "@cap/env";
import type { AiGenerationLanguage } from "@cap/web-domain";
import { FatalError } from "workflow";
import {
	createAssemblyAIClient,
	getAssemblyAITranscriptionOptions,
} from "./assemblyai";
import {
	CloudflareTranscriptionError,
	transcribeWithCloudflare,
} from "./cloudflare-transcription";

export async function transcribeAudio(
	audio: Uint8Array,
	language: AiGenerationLanguage,
	contentType = "audio/mpeg",
	sourceDurationMs?: number,
) {
	const env = serverEnv();
	if (env.TRANSCRIPTION_PROVIDER === "cloudflare") {
		try {
			return await transcribeWithCloudflare(
				audio,
				language,
				{
					accountId: env.CLOUDFLARE_ACCOUNT_ID,
					apiToken: env.CLOUDFLARE_AI_API_TOKEN,
				},
				fetch,
				contentType,
				sourceDurationMs,
			);
		} catch (error) {
			if (error instanceof CloudflareTranscriptionError && !error.retryable) {
				throw new FatalError(error.message);
			}
			throw error;
		}
	}
	return createAssemblyAIClient().transcripts.transcribe({
		audio: Buffer.from(audio),
		...getAssemblyAITranscriptionOptions(language),
		disfluencies: true,
	});
}
