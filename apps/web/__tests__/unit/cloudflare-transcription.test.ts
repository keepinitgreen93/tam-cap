import { describe, expect, it } from "vitest";
import {
	CLOUDFLARE_SPEECH_MODEL,
	parseCloudflareTranscription,
	transcribeWithCloudflare,
} from "../../lib/cloudflare-transcription";
import { cloudflareWhisperLongFixture } from "../fixtures/cloudflare-whisper-long-response";
import { cloudflareWhisperResponse } from "../fixtures/cloudflare-whisper-response";

const credentials = {
	accountId: "0123456789abcdef0123456789abcdef",
	apiToken: "test-token",
};
function response(
	words: unknown[] = [
		{ word: " Um,", start: 0.1, end: 0.3 },
		{ word: " hello.", start: 0.5, end: 1 },
	],
	text = "Um, hello.",
) {
	return {
		success: true,
		result: {
			transcription_info: {
				duration: 2,
				language: "en",
				language_probability: 1,
			},
			text,
			segments: [{ text, words }],
		},
	};
}

describe("Cloudflare Whisper transcription", () => {
	it("preserves every spoken reference token from the real 200-second VAD regression", () => {
		const { response, sourceDurationMs, expectedNormalizedTokens } =
			cloudflareWhisperLongFixture;
		const transcript = parseCloudflareTranscription(response, sourceDurationMs);
		expect(transcript.status).toBe("completed");
		expect(transcript.words).toHaveLength(409);
		const tokens = transcript.words.flatMap(
			(word) => word.text.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? [],
		);
		expect(tokens).toEqual(expectedNormalizedTokens);
		expect(tokens).toHaveLength(410);
		expect(
			transcript.words.every(
				(word) =>
					word.end > word.start &&
					word.start >= 0 &&
					word.end <= sourceDurationMs,
			),
		).toBe(true);
	});
	it("preserves the live synthetic fixture's fillers and exact provider word boundaries", () => {
		const transcript = parseCloudflareTranscription(
			cloudflareWhisperResponse,
			17134,
		);
		expect(transcript.speech_model_used).toBe(
			"@cf/openai/whisper-large-v3-turbo",
		);
		expect(transcript.words).toHaveLength(25);
		expect(transcript.words[0]).toEqual({
			text: "Hello.",
			start: 0,
			end: 340,
			confidence: null,
			speaker: null,
			channel: "0",
		});
		expect(transcript.words[1]).toMatchObject({
			text: "Um,",
			start: 960,
			end: 1620,
		});
		expect(transcript.words[8]).toMatchObject({
			text: "Uh,",
			start: 6260,
			end: 6920,
		});
		expect(transcript.words.at(-1)).toMatchObject({
			text: "words.",
			start: 15040,
			end: 15460,
		});
		expect(
			transcript.words.every(
				(word) => word.confidence === null && word.speaker === null,
			),
		).toBe(true);
		expect(transcript.audio_duration).toBe(17.134);
		expect(transcript.language_code).toBe("en");
	});
	it("uses source duration when the response omits duration metadata", () => {
		const value = response();
		const shape = {
			success: true,
			result: { text: value.result.text, segments: value.result.segments },
		};
		expect(parseCloudflareTranscription(shape, 2000).audio_duration).toBe(2);
		expect(() => parseCloudflareTranscription(shape)).toThrow("duration");
	});
	it.each([NaN, Infinity, 0, -1])(
		"rejects invalid source duration %s",
		(duration) => {
			expect(() => parseCloudflareTranscription(response(), duration)).toThrow(
				"duration",
			);
		},
	);
	it.each([
		{ word: "bad", start: -1, end: 1 },
		{ word: "bad", start: 1, end: 0.5 },
		{ word: "bad", start: 0, end: NaN },
		{ word: "bad", start: 0, end: 3 },
		{ word: "bad", start: "0", end: 1 },
		{ word: "", start: 0, end: 1 },
		{ word: "bad", start: 0, end: 0.0001 },
		{ word: "bad", start: 0, end: 1, confidence: 2 },
		{ word: "bad", start: 0, end: 1, confidence: NaN },
		{ word: "bad", start: 0, end: 1, confidence: "1" },
	])(
		"rejects invalid timing or confidence instead of inventing an edit",
		(word) => {
			expect(() => parseCloudflareTranscription(response([word]))).toThrow();
		},
	);
	it("preserves overlaps without fabricating diarization", () => {
		const transcript = parseCloudflareTranscription(
			response([
				{ word: "um", start: 0.1, end: 0.5 },
				{ word: "yes", start: 0.2, end: 0.6, confidence: 0.9 },
			]),
		);
		expect(
			transcript.words.map((word) => [
				word.start,
				word.end,
				word.speaker,
				word.confidence,
			]),
		).toEqual([
			[100, 500, null, null],
			[200, 600, null, 0.9],
		]);
	});
	it("accepts confirmed silence but rejects text without timed words", () => {
		expect(
			parseCloudflareTranscription(
				{ success: true, result: { text: "", segments: [] } },
				2000,
			),
		).toMatchObject({ status: "error", error: "No spoken audio", words: [] });
		expect(() => parseCloudflareTranscription(response([]))).toThrow(
			"word timings",
		);
		expect(() =>
			parseCloudflareTranscription(
				{ success: true, result: { text: "speech", segments: [] } },
				2000,
			),
		).toThrow("word timings");
		expect(() =>
			parseCloudflareTranscription(
				{
					success: true,
					result: { text: "speech", segments: [{ text: "speech" }] },
				},
				2000,
			),
		).toThrow("word timings");
	});
	it.each([
		null,
		[],
		{ success: false, errors: [{ message: "private" }] },
		{ success: true, result: {} },
	])("rejects malformed or unsuccessful envelopes", (shape) => {
		expect(() => parseCloudflareTranscription(shape, 2000)).toThrow();
	});
	it("rejects malformed language confidence", () => {
		const shape = response();
		shape.result.transcription_info.language_probability = 2;
		expect(() => parseCloudflareTranscription(shape)).toThrow("confidence");
	});
	it.each(["en", "es", "auto"])(
		"sends base64 JSON to Cloudflare with language %s and no fixture prompt",
		async (language) => {
			const audio = new Uint8Array([1, 2, 3]);
			let request: Request | undefined;
			const result = await transcribeWithCloudflare(
				audio,
				language,
				credentials,
				async (url, init) => {
					request = new Request(url, init);
					return Response.json(response());
				},
				"audio/mpeg",
				2000,
			);
			expect(result.speech_model_used).toBe(CLOUDFLARE_SPEECH_MODEL);
			if (!request) throw Error("Missing request");
			expect(request.url).toBe(
				`https://api.cloudflare.com/client/v4/accounts/${credentials.accountId}/ai/run/${CLOUDFLARE_SPEECH_MODEL}`,
			);
			expect(request.headers.get("content-type")).toBe("application/json");
			expect(request.redirect).toBe("error");
			expect(await request.json()).toEqual({
				audio: "AQID",
				task: "transcribe",
				vad_filter: true,
				...(language === "auto" ? {} : { language }),
			});
		},
	);
	it.each([undefined, NaN, 0])(
		"rejects missing/invalid source duration before paid inference",
		async (duration) => {
			let calls = 0;
			await expect(
				transcribeWithCloudflare(
					new Uint8Array([1]),
					"auto",
					credentials,
					async () => {
						calls++;
						return Response.json(response());
					},
					"audio/mpeg",
					duration,
				),
			).rejects.toThrow("source audio duration");
			expect(calls).toBe(0);
		},
	);
	it("rejects missing credentials and empty audio before inference", async () => {
		await expect(
			transcribeWithCloudflare(new Uint8Array([1]), "auto", {
				...credentials,
				apiToken: "",
			}),
		).rejects.toThrow("credentials");
		await expect(
			transcribeWithCloudflare(new Uint8Array(), "auto", credentials),
		).rejects.toThrow("Empty Cloudflare");
	});
	it.each([
		[401, false],
		[429, true],
		[503, true],
	])(
		"classifies HTTP %s without leaking response content or retrying",
		async (status, retryable) => {
			let calls = 0;
			await expect(
				transcribeWithCloudflare(
					new Uint8Array([1]),
					"auto",
					credentials,
					async () => {
						calls++;
						return new Response("private-details", { status });
					},
					"audio/mpeg",
					2000,
				),
			).rejects.toMatchObject({
				message: `Cloudflare transcription HTTP ${status}`,
				retryable,
			});
			expect(calls).toBe(1);
		},
	);
	it("classifies network failures as retryable and invalid JSON as permanent", async () => {
		await expect(
			transcribeWithCloudflare(
				new Uint8Array([1]),
				"auto",
				credentials,
				async () => {
					throw Error("private-network-url");
				},
				"audio/mpeg",
				2000,
			),
		).rejects.toMatchObject({
			message: "Cloudflare transcription request failed",
			retryable: true,
		});
		await expect(
			transcribeWithCloudflare(
				new Uint8Array([1]),
				"auto",
				credentials,
				async () => new Response("not-json"),
				"audio/mpeg",
				2000,
			),
		).rejects.toMatchObject({
			message: "Invalid Cloudflare transcription JSON",
			retryable: false,
		});
	});
});
