import { spawn } from "bun";
import { z } from "zod";
import {
	registerSubprocess,
	terminateProcess,
	unregisterSubprocess,
} from "./subprocess";

export type QuietRange = { startMs: number; endMs: number };

export class SilencePcmScanner {
	private pending = new Uint8Array(0);
	private samples = 0;
	private windowSamples = 0;
	private sums: number[];
	private peaks: number[];
	private quietStart: number | null = null;
	private ranges: QuietRange[] = [];

	constructor(
		private readonly channels: number,
		private readonly offsetMs = 0,
		private readonly sampleRate = 16000,
	) {
		if (
			!Number.isInteger(channels) ||
			channels < 1 ||
			channels > 64 ||
			!Number.isFinite(offsetMs) ||
			offsetMs < 0 ||
			!Number.isInteger(sampleRate) ||
			sampleRate < 1000 ||
			sampleRate > 384000
		)
			throw new Error("Invalid audio layout");
		this.sums = Array.from({ length: channels }, () => 0);
		this.peaks = Array.from({ length: channels }, () => 0);
	}

	push(chunk: Uint8Array) {
		const bytes = new Uint8Array(this.pending.length + chunk.length);
		bytes.set(this.pending);
		bytes.set(chunk, this.pending.length);
		const frameBytes = this.channels * 4;
		const end = bytes.length - (bytes.length % frameBytes);
		const view = new DataView(bytes.buffer, bytes.byteOffset, end);
		for (let offset = 0; offset < end; offset += frameBytes) {
			for (let channel = 0; channel < this.channels; channel++) {
				const sample = view.getFloat32(offset + channel * 4, true);
				if (!Number.isFinite(sample)) throw new Error("Invalid audio samples");
				this.sums[channel] = (this.sums[channel] ?? 0) + sample * sample;
				this.peaks[channel] = Math.max(
					this.peaks[channel] ?? 0,
					Math.abs(sample),
				);
			}
			this.samples++;
			this.windowSamples++;
			if (this.windowSamples === Math.round(this.sampleRate * 0.02))
				this.finishWindow();
		}
		this.pending = bytes.slice(end);
	}

	private finishWindow() {
		const start = this.samples - this.windowSamples;
		const quiet = this.sums.every(
			(sum, channel) =>
				Math.sqrt(sum / this.windowSamples) <= 0.001 &&
				(this.peaks[channel] ?? 0) <= 0.003,
		);
		if (quiet && this.quietStart === null) this.quietStart = start;
		if (!quiet) this.finishQuiet(start);
		this.sums.fill(0);
		this.peaks.fill(0);
		this.windowSamples = 0;
	}

	private finishQuiet(end: number) {
		if (
			this.quietStart !== null &&
			(end - this.quietStart) / this.sampleRate >= 0.8
		) {
			this.ranges.push({
				startMs:
					Math.ceil(
						this.offsetMs + (this.quietStart / this.sampleRate) * 1000,
					) + 150,
				endMs: Math.floor(this.offsetMs + (end / this.sampleRate) * 1000) - 150,
			});
		}
		this.quietStart = null;
	}

	finish() {
		if (this.pending.length || !this.samples)
			throw new Error("Incomplete or missing audio samples");
		if (this.windowSamples) this.finishWindow();
		this.finishQuiet(this.samples);
		return {
			ranges: this.ranges,
			durationMs: (this.samples / this.sampleRate) * 1000,
		};
	}
}

export function intersectQuietRanges(
	left: readonly QuietRange[],
	right: readonly QuietRange[],
) {
	const result: QuietRange[] = [];
	let a = 0;
	let b = 0;
	while (a < left.length && b < right.length) {
		const first = left[a];
		const second = right[b];
		if (!first || !second) break;
		const startMs = Math.max(first.startMs, second.startMs);
		const endMs = Math.min(first.endMs, second.endMs);
		if (endMs - startMs >= 50) result.push({ startMs, endMs });
		if (first.endMs < second.endMs) a++;
		else b++;
	}
	return result;
}

const probeSchema = z.object({
	format: z.object({
		duration: z.coerce.number().positive().finite(),
		start_time: z.coerce.number().finite().optional(),
	}),
	streams: z.array(
		z.object({
			index: z.number().int().nonnegative(),
			codec_type: z.string(),
			channels: z.number().int().min(1).max(64).optional(),
			sample_rate: z.coerce.number().int().min(1000).max(384000).optional(),
			start_time: z.coerce.number().finite().optional(),
			duration: z.coerce.number().positive().finite().optional(),
		}),
	),
});

async function runProcess(
	args: string[],
	signal: AbortSignal,
	consume: (chunk: Uint8Array) => void,
) {
	signal.throwIfAborted();
	const proc = registerSubprocess(
		spawn({ cmd: args, stdout: "pipe", stderr: "ignore", stdin: "ignore" }),
	);
	const abort = () => {
		proc.kill();
	};
	signal.addEventListener("abort", abort, { once: true });
	try {
		for await (const chunk of proc.stdout) {
			signal.throwIfAborted();
			consume(chunk);
		}
		if ((await proc.exited) !== 0)
			throw new Error("Audio analysis process failed");
		signal.throwIfAborted();
	} finally {
		signal.removeEventListener("abort", abort);
		await terminateProcess(proc);
		unregisterSubprocess(proc);
	}
}

export async function analyzeSilenceFile(
	path: string,
	durationMs: number,
	signal: AbortSignal,
) {
	let probeOutput = "";
	await runProcess(
		[
			"ffprobe",
			"-v",
			"error",
			"-protocol_whitelist",
			"file,pipe",
			"-f",
			"mov",
			"-enable_drefs",
			"0",
			"-use_absolute_path",
			"0",
			"-show_entries",
			"format=duration,start_time:stream=index,codec_type,channels,sample_rate,start_time,duration",
			"-of",
			"json",
			path,
		],
		signal,
		(chunk) => {
			probeOutput += new TextDecoder().decode(chunk);
			if (probeOutput.length > 128 * 1024)
				throw new Error("Audio probe output is too large");
		},
	);
	const probe = probeSchema.parse(JSON.parse(probeOutput));
	const video = probe.streams.find((stream) => stream.codec_type === "video");
	const videoDurationMs = (video?.duration ?? probe.format.duration) * 1000;
	const containerDifferenceMs = Math.abs(
		probe.format.duration * 1000 - durationMs,
	);
	if (
		containerDifferenceMs > 50 &&
		(Math.abs(videoDurationMs - durationMs) > 50 || containerDifferenceMs > 100)
	)
		throw new Error("Video duration changed");
	const tracks = probe.streams.filter(
		(stream) => stream.codec_type === "audio",
	);
	if (!tracks.length) throw new Error("Video has no audio track");
	let ranges: QuietRange[] | null = null;
	for (const track of tracks) {
		if (!track.channels || !track.sample_rate || track.start_time === undefined)
			throw new Error("Audio track timing is unavailable");
		const offsetMs = (track.start_time - (probe.format.start_time ?? 0)) * 1000;
		if (offsetMs < 0 || offsetMs >= durationMs)
			throw new Error("Audio track timing is invalid");
		const scanner = new SilencePcmScanner(
			track.channels,
			offsetMs,
			track.sample_rate,
		);
		await runProcess(
			[
				"ffmpeg",
				"-v",
				"error",
				"-nostdin",
				"-protocol_whitelist",
				"file,pipe",
				"-f",
				"mov",
				"-enable_drefs",
				"0",
				"-use_absolute_path",
				"0",
				"-i",
				path,
				"-map",
				`0:${track.index}`,
				"-vn",
				"-sn",
				"-dn",
				"-acodec",
				"pcm_f32le",
				"-f",
				"f32le",
				"pipe:1",
			],
			signal,
			(chunk) => scanner.push(chunk),
		);
		const decoded = scanner.finish();
		if (
			decoded.durationMs + offsetMs > durationMs + 100 ||
			(track.duration !== undefined &&
				Math.abs(decoded.durationMs - track.duration * 1000) > 100)
		)
			throw new Error("Decoded audio timing is inconsistent");
		const current = decoded.ranges.filter((range) => range.endMs <= durationMs);
		ranges = ranges === null ? current : intersectQuietRanges(ranges, current);
	}
	return {
		version: 1 as const,
		profile: "pcm-quiet-v1" as const,
		durationMs,
		audioTracks: tracks.length,
		ranges: ranges ?? [],
	};
}
