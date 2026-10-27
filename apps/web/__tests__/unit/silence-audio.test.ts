import { afterEach, describe, expect, it, vi } from "vitest";
import { scanVideoSilence } from "@/lib/silence-audio";

afterEach(() => vi.unstubAllGlobals());

function audioFixture(duration = 2) {
	const samples = new Float32Array(32000);
	const decode = vi.fn().mockResolvedValue({
		duration,
		numberOfChannels: 1,
		sampleRate: 16000,
		getChannelData: () => samples,
	});
	vi.stubGlobal(
		"OfflineAudioContext",
		class {
			decodeAudioData = decode;
		},
	);
	const fetchMock = vi
		.fn()
		.mockResolvedValue(new Response(new Uint8Array([1, 2, 3])));
	vi.stubGlobal("fetch", fetchMock);
	return { decode, fetchMock };
}

describe("browser silence scan", () => {
	it("analyzes decoded PCM in the video's timeline", async () => {
		const { fetchMock } = audioFixture();
		const signal = new AbortController().signal;
		expect(await scanVideoSilence("/video.mp4", 2, signal)).toEqual([
			{ startMs: 150, endMs: 1850 },
		]);
		expect(fetchMock).toHaveBeenCalledWith("/video.mp4", {
			signal,
			cache: "no-store",
		});
	});

	it("rejects timing mismatch without stretching audio to match video", async () => {
		audioFixture(1);
		await expect(
			scanVideoSilence("/video.mp4", 2, new AbortController().signal),
		).rejects.toThrow("timing");
	});

	it("checks duration limits before downloading", async () => {
		const { fetchMock } = audioFixture();
		await expect(
			scanVideoSilence("/video.mp4", 1801, new AbortController().signal),
		).rejects.toThrow("30 minutes");
		expect(fetchMock).not.toHaveBeenCalled();
	});

	it("cancels oversized responses without decoding", async () => {
		const { decode, fetchMock } = audioFixture();
		const cancel = vi.fn();
		fetchMock.mockResolvedValue(
			new Response(new ReadableStream({ cancel }), {
				headers: { "content-length": `${129 * 1024 * 1024}` },
			}),
		);
		await expect(
			scanVideoSilence("/video.mp4", 2, new AbortController().signal),
		).rejects.toThrow("128 MB");
		expect(cancel).toHaveBeenCalled();
		expect(decode).not.toHaveBeenCalled();
	});

	it("does not return a result after cancellation during decoding", async () => {
		const { decode } = audioFixture();
		const controller = new AbortController();
		decode.mockImplementation(async () => {
			controller.abort();
			return { duration: 2 };
		});
		await expect(
			scanVideoSilence("/video.mp4", 2, controller.signal),
		).rejects.toThrow();
	});

	it("reports absent audio and download failures without generating cuts", async () => {
		const { decode, fetchMock } = audioFixture();
		decode.mockRejectedValue(new Error("no audio"));
		await expect(
			scanVideoSilence("/video.mp4", 2, new AbortController().signal),
		).rejects.toThrow("decode");
		fetchMock.mockResolvedValue(new Response(null, { status: 403 }));
		await expect(
			scanVideoSilence("/video.mp4", 2, new AbortController().signal),
		).rejects.toThrow("load");
	});
});
