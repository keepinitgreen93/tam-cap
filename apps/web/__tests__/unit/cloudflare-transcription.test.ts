import { describe, expect, it } from "vitest";
import {
	parseCloudflareTranscription,
	transcribeWithCloudflare,
} from "../../lib/cloudflare-transcription";

const credentials = {
	accountId: "0123456789abcdef0123456789abcdef",
	apiToken: "test-token",
};

function response(
	words: unknown[] = [
		{
			word: "um",
			punctuated_word: "Um,",
			start: 0.1,
			end: 0.3,
			confidence: 0.9,
		},
		{
			word: "hello",
			punctuated_word: "hello.",
			start: 0.5,
			end: 1,
			confidence: 1,
		},
	],
	transcript = "Um, hello.",
) {
	return {
		success: true,
		result: {
			metadata: { duration: 2, request_id: "request-123" },
			results: {
				channels: [
					{
						detected_language: "en",
						alternatives: [{ transcript, words }],
					},
				],
			},
		},
	};
}

describe("Cloudflare transcription", () => {
	it("does not spend inference when source duration is unavailable", async () => {
		let requests = 0;
		await expect(
			transcribeWithCloudflare(
				new Uint8Array([1]),
				"auto",
				credentials,
				async () => {
					requests += 1;
					return Response.json(response());
				},
			),
		).rejects.toThrow("source audio duration");
		expect(requests).toBe(0);
	});

	it("uses known source duration for the live Cloudflare envelope without Deepgram metadata", () => {
		const liveShape = {
			success: true,
			result: {
				results: {
					channels: [
						{
							alternatives: [
								{
									transcript: "um hello",
									words: [
										{ word: "um", start: 0.1, end: 0.3 },
										{ word: "hello", start: 0.5, end: 1 },
									],
								},
							],
						},
					],
				},
				usage: { neurons: 66.0911 },
			},
		};
		const result = parseCloudflareTranscription(liveShape, 8388);
		expect(result.audio_duration).toBe(8.388);
		expect(result.words[1]?.end).toBe(1000);
		expect(() => parseCloudflareTranscription(liveShape)).toThrow("duration");
	});

	it("preserves filler tokens and converts seconds to millisecond edit times", () => {
		const result = parseCloudflareTranscription(response());
		expect(result.words).toEqual([
			{
				text: "Um,",
				start: 100,
				end: 300,
				confidence: 0.9,
				speaker: null,
				channel: "0",
			},
			{
				text: "hello.",
				start: 500,
				end: 1000,
				confidence: 1,
				speaker: null,
				channel: "0",
			},
		]);
		expect(result.audio_duration).toBe(2);
		expect(result.language_code).toBe("en");
	});

	it.each([
		{ word: "wrong", start: -1, end: 1 },
		{ word: "wrong", start: 1, end: 0.5 },
		{ word: "wrong", start: 0, end: Number.NaN },
		{ word: "wrong", start: 0, end: 3 },
		{ word: "wrong", start: "0", end: 1 },
		{ word: "", start: 0, end: 1 },
	])("rejects malformed word timing rather than inventing a cut", (word) => {
		expect(() => parseCloudflareTranscription(response([word]))).toThrow();
	});

	it("preserves overlapping speech so the editor can refuse unsafe cuts", () => {
		const result = parseCloudflareTranscription(
			response([
				{ word: "um", start: 0.1, end: 0.5, speaker: 0 },
				{ word: "yes", start: 0.2, end: 0.6, speaker: 1 },
			]),
		);
		expect(
			result.words.map((word) => [word.start, word.end, word.speaker]),
		).toEqual([
			[100, 500, "0"],
			[200, 600, "1"],
		]);
	});

	it("rejects provider error envelopes and missing word data", () => {
		expect(() =>
			parseCloudflareTranscription({
				success: false,
				errors: [{ message: "private error" }],
			}),
		).toThrow("Cloudflare transcription failed");
		expect(() =>
			parseCloudflareTranscription({ success: true, result: {} }),
		).toThrow();
	});

	it("treats confirmed empty speech as no-audio but rejects text without word timing", () => {
		const silent = response([], "");
		expect(parseCloudflareTranscription(silent)).toMatchObject({
			status: "error",
			error: "No spoken audio",
			words: [],
		});
		expect(() => parseCloudflareTranscription(response([]))).toThrow(
			"Missing Cloudflare word timings",
		);
	});

	it("treats permanent HTTP errors as non-retryable without exposing the response", async () => {
		await expect(
			transcribeWithCloudflare(
				new Uint8Array([1]),
				"auto",
				credentials,
				async () => new Response("secret-provider-detail", { status: 401 }),
				"audio/mpeg",
				2000,
			),
		).rejects.toMatchObject({
			message: "Cloudflare transcription HTTP 401",
			retryable: false,
		});
	});

	it("sends raw audio only to Cloudflare with filler retention and explicit language", async () => {
		const audio = new Uint8Array([1, 2, 3]);
		let request: Request | undefined;
		const result = await transcribeWithCloudflare(
			audio,
			"en",
			credentials,
			async (input, init) => {
				request = new Request(input, init);
				return Response.json(response());
			},
			"audio/mpeg",
			2000,
		);
		expect(result.words[0]?.text).toBe("Um,");
		expect(request?.url).toContain(
			"https://api.cloudflare.com/client/v4/accounts/0123456789abcdef0123456789abcdef/ai/run/@cf/deepgram/nova-3?",
		);
		expect(new URL(request?.url ?? "").searchParams.get("filler_words")).toBe(
			"true",
		);
		expect(new URL(request?.url ?? "").searchParams.get("language")).toBe("en");
		expect(request?.headers.get("content-type")).toBe("audio/mpeg");
		expect(request?.redirect).toBe("error");
		if (!request) throw new Error("Missing Cloudflare request");
		expect(new Uint8Array(await request.arrayBuffer())).toEqual(audio);
	});

	it("fails closed for missing credentials without making a request", async () => {
		await expect(
			transcribeWithCloudflare(
				new Uint8Array([1]),
				"auto",
				{ ...credentials, apiToken: "" },
				async () => {
					throw new Error("Network request must not happen");
				},
			),
		).rejects.toThrow("Cloudflare transcription credentials");
	});

	it("surfaces a retryable status without leaking provider response or retrying paid inference", async () => {
		let calls = 0;
		await expect(
			transcribeWithCloudflare(
				new Uint8Array([1]),
				"auto",
				credentials,
				async () => {
					calls += 1;
					return new Response("private details", { status: 429 });
				},
				"audio/mpeg",
				2000,
			),
		).rejects.toThrow("Cloudflare transcription HTTP 429");
		expect(calls).toBe(1);
	});
});
