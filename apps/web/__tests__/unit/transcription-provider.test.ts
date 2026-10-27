import { beforeEach, describe, expect, it, vi } from "vitest";
import type { TranscriptionEnvironment } from "../../lib/transcription-config";
import { isTranscriptionConfigured } from "../../lib/transcription-config";

const state = vi.hoisted(() => ({
	env: {} as TranscriptionEnvironment,
	assemblyCalls: 0,
}));
vi.mock("@cap/env", () => ({ serverEnv: () => state.env }));
vi.mock("../../lib/assemblyai", () => ({
	createAssemblyAIClient: () => ({
		transcripts: {
			transcribe: async () => {
				state.assemblyCalls += 1;
				return {
					status: "completed",
					words: [{ text: "existing", start: 0, end: 100 }],
				};
			},
		},
	}),
	getAssemblyAITranscriptionOptions: () => ({}),
}));

import { transcribeAudio } from "../../lib/transcription-provider";

beforeEach(() => {
	state.env = { ASSEMBLY_API_KEY: "existing-key" };
	state.assemblyCalls = 0;
});

describe("transcription provider selection", () => {
	it("keeps the existing provider when no selector is configured", async () => {
		expect(isTranscriptionConfigured(state.env)).toBe(true);
		const transcript = await transcribeAudio(new Uint8Array([1]), "auto");
		expect(transcript.words?.[0]?.text).toBe("existing");
	});

	it("does not use an existing AssemblyAI key when Cloudflare credentials are missing", async () => {
		state.env.TRANSCRIPTION_PROVIDER = "cloudflare";
		expect(isTranscriptionConfigured(state.env)).toBe(false);
		await expect(transcribeAudio(new Uint8Array([1]), "auto")).rejects.toThrow(
			"Cloudflare transcription credentials",
		);
		expect(state.assemblyCalls).toBe(0);
	});

	it("does not fall back outside Cloudflare on a transient failure", async () => {
		state.env = {
			...state.env,
			TRANSCRIPTION_PROVIDER: "cloudflare",
			CLOUDFLARE_ACCOUNT_ID: "0123456789abcdef0123456789abcdef",
			CLOUDFLARE_AI_API_TOKEN: "test-token",
		};
		vi.stubGlobal(
			"fetch",
			async () => new Response("unavailable", { status: 503 }),
		);
		try {
			await expect(
				transcribeAudio(new Uint8Array([1]), "auto", "audio/mpeg", 2000),
			).rejects.toMatchObject({ retryable: true });
			expect(state.assemblyCalls).toBe(0);
		} finally {
			vi.unstubAllGlobals();
		}
	});
});
