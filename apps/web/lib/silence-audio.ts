import { detectPcmSilence } from "@/lib/silence-cuts";

const MAX_AUDIO_SCAN_BYTES = 128 * 1024 * 1024;
const MAX_AUDIO_SCAN_SECONDS = 30 * 60;

export async function scanVideoSilence(
	src: string,
	durationSeconds: number,
	signal: AbortSignal,
) {
	if (!Number.isFinite(durationSeconds) || durationSeconds <= 0) {
		throw new Error("Wait for the video to finish loading before scanning.");
	}
	if (durationSeconds > MAX_AUDIO_SCAN_SECONDS) {
		throw new Error(
			"Browser silence scanning supports videos up to 30 minutes. Use the timeline to review this longer recording.",
		);
	}
	if (typeof OfflineAudioContext === "undefined") {
		throw new Error("This browser cannot analyze audio for silence.");
	}
	const response = await fetch(src, { signal, cache: "no-store" });
	if (!response.ok || !response.body) {
		throw new Error("Could not load the video audio. Please try again.");
	}
	const reader = response.body.getReader();
	const chunks: Uint8Array[] = [];
	let size = 0;
	try {
		if (Number(response.headers.get("content-length")) > MAX_AUDIO_SCAN_BYTES) {
			throw new Error("This video exceeds the 128 MB browser scan limit.");
		}
		while (true) {
			signal.throwIfAborted();
			const { value, done } = await reader.read();
			if (done) break;
			size += value.byteLength;
			if (size > MAX_AUDIO_SCAN_BYTES) {
				throw new Error("This video exceeds the 128 MB browser scan limit.");
			}
			chunks.push(value);
		}
	} finally {
		try {
			await reader.cancel();
		} finally {
			reader.releaseLock();
		}
	}
	const encoded = new Uint8Array(size);
	let offset = 0;
	for (const chunk of chunks) {
		encoded.set(chunk, offset);
		offset += chunk.byteLength;
	}
	chunks.length = 0;
	signal.throwIfAborted();
	const context = new OfflineAudioContext(1, 1, 16000);
	let decoded: AudioBuffer;
	try {
		decoded = await context.decodeAudioData(encoded.buffer);
	} catch {
		throw new Error(
			"This browser could not decode the video audio for scanning.",
		);
	}
	signal.throwIfAborted();
	if (Math.abs(decoded.duration - durationSeconds) > 0.05) {
		throw new Error(
			"The audio timing does not match the video. No silence cuts were created.",
		);
	}
	const channels = Array.from(
		{ length: decoded.numberOfChannels },
		(_, index) => decoded.getChannelData(index),
	);
	return detectPcmSilence(channels, decoded.sampleRate);
}
