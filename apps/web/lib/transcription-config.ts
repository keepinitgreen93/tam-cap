export type TranscriptionEnvironment = {
	TRANSCRIPTION_PROVIDER?: "assemblyai" | "cloudflare";
	ASSEMBLY_API_KEY?: string;
	CLOUDFLARE_ACCOUNT_ID?: string;
	CLOUDFLARE_AI_API_TOKEN?: string;
};

export function isTranscriptionConfigured(
	env: TranscriptionEnvironment,
): boolean {
	if (env.TRANSCRIPTION_PROVIDER === "cloudflare") {
		return Boolean(
			env.CLOUDFLARE_ACCOUNT_ID &&
				/^[a-f0-9]{32}$/i.test(env.CLOUDFLARE_ACCOUNT_ID) &&
				env.CLOUDFLARE_AI_API_TOKEN?.trim(),
		);
	}
	return Boolean(env.ASSEMBLY_API_KEY?.trim());
}
