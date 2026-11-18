import { describe, expect, it } from "vitest";
import {
	CLOUDFLARE_CHUNK_CONCURRENCY,
	CLOUDFLARE_CHUNK_MS,
	CLOUDFLARE_CHUNK_THRESHOLD_MS,
	transcribeWithCloudflare,
} from "../../lib/cloudflare-transcription";
import { indexMp3Frames, mp3DurationMs, splitMp3 } from "../../lib/mp3-chunks";

const credentials = {
	accountId: "0123456789abcdef0123456789abcdef",
	apiToken: "test-token",
};
const FRAME_MS = (1152 / 44100) * 1000;

/**
 * MPEG-1 layer III, 128 kbps, 44.1 kHz. Real encoders alternate the padding
 * bit, which the splitter has to honor, so this does too. Each payload starts
 * with its frame number so a fake provider can tell which slice it received.
 */
function fakeMp3(frameCount: number, withId3 = true) {
	const parts: Uint8Array[] = [];
	if (withId3) {
		const tag = new Uint8Array(10 + 32);
		tag.set([0x49, 0x44, 0x33, 4, 0, 0, 0, 0, 0, 32]);
		parts.push(tag);
	}
	for (let index = 0; index < frameCount; index++) {
		const padded = index % 3 === 0;
		const frame = new Uint8Array(padded ? 418 : 417);
		frame.set([0xff, 0xfb, padded ? 0x92 : 0x90, 0x00]);
		new DataView(frame.buffer).setUint32(4, index);
		parts.push(frame);
	}
	const out = new Uint8Array(parts.reduce((sum, part) => sum + part.length, 0));
	let offset = 0;
	for (const part of parts) {
		out.set(part, offset);
		offset += part.length;
	}
	return out;
}

function firstFrameOf(body: { audio: string }) {
	const bytes = Buffer.from(body.audio, "base64");
	return new DataView(bytes.buffer, bytes.byteOffset).getUint32(4);
}

/** A fake Whisper that hears one word every 10 s of the original recording. */
function whisper(calls: { language?: string; frames: number }[] = []) {
	let running = 0;
	let peak = 0;
	const fetcher = async (_url: RequestInfo | URL, init?: RequestInit) => {
		running++;
		peak = Math.max(peak, running);
		try {
			const body = JSON.parse(String(init?.body));
			const bytes = Buffer.from(body.audio, "base64");
			const frames = indexMp3Frames(bytes);
			if (!frames) throw Error("slice is not a clean mp3");
			calls.push({
				language: body.language,
				frames: frames.offsets.length - 1,
			});
			const startMs = firstFrameOf(body) * FRAME_MS;
			const durationMs = mp3DurationMs(frames);
			const words = [];
			for (let at = 0; at < startMs + durationMs; at += 10_000) {
				if (at < startMs) continue;
				const relative = (at - startMs) / 1000;
				words.push({
					word: ` w${at / 1000}`,
					start: relative,
					end: relative + 0.4,
				});
			}
			await new Promise((resolve) => setTimeout(resolve, 5));
			return Response.json({
				success: true,
				result: {
					transcription_info: { language: "en", language_probability: 1 },
					text: "x",
					segments: [{ text: "x", words }],
				},
			});
		} finally {
			running--;
		}
	};
	return { fetcher, peak: () => peak };
}

describe("MP3 frame splitting", () => {
	it("indexes frames across alternating padding and an ID3 tag", () => {
		const frames = indexMp3Frames(fakeMp3(500));
		expect(frames?.offsets).toHaveLength(501);
		expect(frames?.sampleRate).toBe(44100);
		expect(mp3DurationMs(frames as never)).toBeCloseTo(500 * FRAME_MS, -1);
	});

	it("refuses anything that is not a clean MP3", () => {
		expect(indexMp3Frames(new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8]))).toBeNull();
		expect(indexMp3Frames(new Uint8Array(0))).toBeNull();
	});

	it("covers the stream with overlapping slices on whole frames", () => {
		const bytes = fakeMp3(8000);
		const frames = indexMp3Frames(bytes);
		if (!frames) throw Error("no frames");
		const chunks = splitMp3(bytes, frames, 60_000, 2_000);
		expect(chunks.length).toBe(Math.ceil((8000 * FRAME_MS) / 60_000));
		for (const chunk of chunks) {
			expect(indexMp3Frames(chunk.audio)).not.toBeNull();
		}
		expect(chunks[0]?.coreStartMs).toBe(Number.NEGATIVE_INFINITY);
		expect(chunks.at(-1)?.coreEndMs).toBe(Number.POSITIVE_INFINITY);
		// Each core boundary lies inside both neighboring slices.
		for (let index = 1; index < chunks.length; index++) {
			const before = chunks[index - 1];
			const after = chunks[index];
			expect(before?.endMs).toBeGreaterThan(after?.coreStartMs ?? 0);
			expect(after?.startMs).toBeLessThan(before?.coreEndMs ?? 0);
		}
	});
});

describe("Cloudflare transcription of long recordings", () => {
	it("transcribes a 21 minute recording in parallel pieces and merges one timeline", async () => {
		const frameCount = Math.round((21 * 60 * 1000) / FRAME_MS);
		const bytes = fakeMp3(frameCount);
		const durationMs = Math.round(frameCount * FRAME_MS);
		const calls: { language?: string; frames: number }[] = [];
		const provider = whisper(calls);
		const transcript = await transcribeWithCloudflare(
			bytes,
			"en",
			credentials,
			provider.fetcher,
			"audio/mpeg",
			durationMs,
		);
		expect(calls.length).toBe(Math.ceil(durationMs / CLOUDFLARE_CHUNK_MS));
		expect(calls.every((call) => call.language === "en")).toBe(true);
		expect(provider.peak()).toBeGreaterThan(1);
		expect(provider.peak()).toBeLessThanOrEqual(CLOUDFLARE_CHUNK_CONCURRENCY);
		// One word per 10 s, none doubled where slices overlap, none missing.
		const marks = Math.ceil(durationMs / 10_000);
		expect(transcript.status).toBe("completed");
		expect(transcript.words.map((word) => word.text)).toEqual(
			Array.from({ length: marks }, (_, index) => `w${index * 10}`),
		);
		for (const [index, word] of transcript.words.entries()) {
			expect(Math.abs(word.start - index * 10_000)).toBeLessThanOrEqual(
				Math.round(FRAME_MS) + 1,
			);
			expect(word.end).toBeGreaterThan(word.start);
			expect(word.end).toBeLessThanOrEqual(durationMs);
		}
		expect(transcript.audio_duration).toBeCloseTo(durationMs / 1000, 3);
	});

	it("detects the language on the first piece and reuses it for the rest", async () => {
		const frameCount = Math.round((10 * 60 * 1000) / FRAME_MS);
		const calls: { language?: string; frames: number }[] = [];
		const transcript = await transcribeWithCloudflare(
			fakeMp3(frameCount),
			"auto",
			credentials,
			whisper(calls).fetcher,
			"audio/mpeg",
			Math.round(frameCount * FRAME_MS),
		);
		expect(calls[0]?.language).toBeUndefined();
		expect(calls.slice(1).every((call) => call.language === "en")).toBe(true);
		expect(transcript.language_code).toBe("en");
	});

	it("retries a piece that times out once without redoing the others", async () => {
		const frameCount = Math.round((12 * 60 * 1000) / FRAME_MS);
		const provider = whisper();
		let failed = false;
		let total = 0;
		const transcript = await transcribeWithCloudflare(
			fakeMp3(frameCount),
			"en",
			credentials,
			async (url, init) => {
				total++;
				if (!failed && firstFrameOf(JSON.parse(String(init?.body))) > 0) {
					failed = true;
					throw new DOMException("timed out", "TimeoutError");
				}
				return provider.fetcher(url, init);
			},
			"audio/mpeg",
			Math.round(frameCount * FRAME_MS),
		);
		const pieces = Math.ceil((frameCount * FRAME_MS) / CLOUDFLARE_CHUNK_MS);
		expect(total).toBe(pieces + 1);
		expect(transcript.words.length).toBe(
			Math.ceil((frameCount * FRAME_MS) / 10_000),
		);
	});

	it("fails the whole transcription on a permanent provider error", async () => {
		const frameCount = Math.round((10 * 60 * 1000) / FRAME_MS);
		await expect(
			transcribeWithCloudflare(
				fakeMp3(frameCount),
				"en",
				credentials,
				async () => new Response("denied", { status: 401 }),
				"audio/mpeg",
				Math.round(frameCount * FRAME_MS),
			),
		).rejects.toMatchObject({ retryable: false });
	});

	it("reports silence only when every piece is silent", async () => {
		const frameCount = Math.round((10 * 60 * 1000) / FRAME_MS);
		const transcript = await transcribeWithCloudflare(
			fakeMp3(frameCount),
			"en",
			credentials,
			async () =>
				Response.json({ success: true, result: { text: "", segments: [] } }),
			"audio/mpeg",
			Math.round(frameCount * FRAME_MS),
		);
		expect(transcript).toMatchObject({
			status: "error",
			error: "No spoken audio",
			words: [],
		});
	});

	it("keeps one request for short recordings and for audio it cannot split", async () => {
		let calls = 0;
		const fetcher = async () => {
			calls++;
			return Response.json({
				success: true,
				result: {
					text: "hi",
					segments: [{ text: "hi", words: [{ word: "hi", start: 0, end: 1 }] }],
				},
			});
		};
		const shortFrames = Math.round(
			(CLOUDFLARE_CHUNK_THRESHOLD_MS - 10_000) / FRAME_MS,
		);
		await transcribeWithCloudflare(
			fakeMp3(shortFrames),
			"en",
			credentials,
			fetcher,
			"audio/mpeg",
			Math.round(shortFrames * FRAME_MS),
		);
		expect(calls).toBe(1);
		// Long duration but not an MP3 (or one whose length disagrees with the
		// recording): the previous single-request behavior is kept.
		await transcribeWithCloudflare(
			new Uint8Array(4096).fill(7),
			"en",
			credentials,
			fetcher,
			"audio/mp4",
			20 * 60_000,
		);
		expect(calls).toBe(2);
		await transcribeWithCloudflare(
			fakeMp3(shortFrames),
			"en",
			credentials,
			fetcher,
			"audio/mpeg",
			20 * 60_000,
		);
		expect(calls).toBe(3);
	});
});
