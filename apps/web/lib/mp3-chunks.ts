// Frame-aligned splitting of an MP3 byte stream. The media server produces the
// transcription audio as MP3, and the web runtime has no ffmpeg, so long audio
// is cut on frame boundaries here. Every frame of a layer III stream covers a
// fixed number of samples, which gives exact chunk start times without
// decoding.

const MPEG1_L3_BITRATES = [
	0, 32, 40, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320,
];
const MPEG2_L3_BITRATES = [
	0, 8, 16, 24, 32, 40, 48, 56, 64, 80, 96, 112, 128, 144, 160,
];
const SAMPLE_RATES: Record<number, number[]> = {
	3: [44100, 48000, 32000],
	2: [22050, 24000, 16000],
	0: [11025, 12000, 8000],
};

export interface Mp3Frames {
	sampleRate: number;
	samplesPerFrame: number;
	/** Byte offset of every frame; the final entry is the end of the last frame. */
	offsets: number[];
}

function id3Length(bytes: Uint8Array): number {
	if (
		bytes.length >= 10 &&
		bytes[0] === 0x49 &&
		bytes[1] === 0x44 &&
		bytes[2] === 0x33
	) {
		const size =
			((bytes[6] ?? 0) << 21) |
			((bytes[7] ?? 0) << 14) |
			((bytes[8] ?? 0) << 7) |
			(bytes[9] ?? 0);
		const footer = ((bytes[5] ?? 0) & 0x10) !== 0 ? 10 : 0;
		return 10 + size + footer;
	}
	return 0;
}

/**
 * Walks a layer III stream. Returns null for anything that is not a clean,
 * constant-sample-rate MP3 so callers can fall back to a single request.
 */
export function indexMp3Frames(bytes: Uint8Array): Mp3Frames | null {
	let position = id3Length(bytes);
	const offsets: number[] = [];
	let sampleRate = 0;
	let samplesPerFrame = 0;
	while (position + 4 <= bytes.length) {
		const b0 = bytes[position] ?? 0;
		const b1 = bytes[position + 1] ?? 0;
		const b2 = bytes[position + 2] ?? 0;
		const version = (b1 >> 3) & 3;
		const layer = (b1 >> 1) & 3;
		const bitrateIndex = (b2 >> 4) & 15;
		const rateIndex = (b2 >> 2) & 3;
		const rates = SAMPLE_RATES[version];
		if (
			b0 !== 0xff ||
			(b1 & 0xe0) !== 0xe0 ||
			layer !== 1 ||
			!rates ||
			rateIndex === 3 ||
			bitrateIndex === 0 ||
			bitrateIndex === 15
		) {
			// A trailing tag (ID3v1, APE) ends the audio; anything else is not a
			// stream this splitter understands.
			if (offsets.length > 0 && (b0 === 0x54 || b0 === 0x41 || b0 === 0x00))
				break;
			return null;
		}
		const rate = rates[rateIndex] as number;
		const bitrate =
			((version === 3 ? MPEG1_L3_BITRATES : MPEG2_L3_BITRATES)[
				bitrateIndex
			] as number) * 1000;
		const samples = version === 3 ? 1152 : 576;
		if (sampleRate && (sampleRate !== rate || samplesPerFrame !== samples))
			return null;
		sampleRate = rate;
		samplesPerFrame = samples;
		const length =
			Math.floor((samples / 8) * (bitrate / rate)) + ((b2 >> 1) & 1);
		if (position + length > bytes.length) break;
		offsets.push(position);
		position += length;
	}
	if (offsets.length < 2) return null;
	offsets.push(position);
	return { sampleRate, samplesPerFrame, offsets };
}

export function mp3DurationMs(frames: Mp3Frames): number {
	return Math.round(
		(((frames.offsets.length - 1) * frames.samplesPerFrame) /
			frames.sampleRate) *
			1000,
	);
}

export interface AudioChunk {
	audio: Uint8Array;
	/** Start of the slice in the original timeline. */
	startMs: number;
	endMs: number;
	/** Words are kept only when their midpoint lies in [coreStartMs, coreEndMs). */
	coreStartMs: number;
	coreEndMs: number;
}

/**
 * Cuts the stream into consecutive chunks of about chunkMs. Each slice reaches
 * overlapMs past its core on both sides so a word that straddles a core
 * boundary is whole in one slice and can be assigned to exactly one chunk.
 */
export function splitMp3(
	bytes: Uint8Array,
	frames: Mp3Frames,
	chunkMs: number,
	overlapMs: number,
): AudioChunk[] {
	const frameCount = frames.offsets.length - 1;
	const frameMs = (frames.samplesPerFrame / frames.sampleRate) * 1000;
	const totalMs = frameCount * frameMs;
	const count = Math.max(1, Math.ceil(totalMs / chunkMs));
	const chunks: AudioChunk[] = [];
	for (let index = 0; index < count; index++) {
		const coreStartMs = index * chunkMs;
		const coreEndMs = Math.min(totalMs, (index + 1) * chunkMs);
		const first = Math.min(
			frameCount - 1,
			Math.max(0, Math.floor((coreStartMs - overlapMs) / frameMs)),
		);
		const last = Math.min(
			frameCount,
			Math.max(first + 1, Math.ceil((coreEndMs + overlapMs) / frameMs)),
		);
		chunks.push({
			audio: bytes.subarray(
				frames.offsets[first] as number,
				frames.offsets[last] as number,
			),
			startMs: first * frameMs,
			endMs: last * frameMs,
			coreStartMs: index === 0 ? Number.NEGATIVE_INFINITY : coreStartMs,
			coreEndMs: index === count - 1 ? Number.POSITIVE_INFINITY : coreEndMs,
		});
	}
	return chunks;
}
