import { afterAll, beforeAll, describe, expect, spyOn, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	analyzeSilenceFile,
	intersectQuietRanges,
	SilencePcmScanner,
} from "../lib/silence-analysis";
import { SilenceDiskBudget } from "../lib/silence-disk";
import {
	fetchSilenceSource,
	validateSilenceSource,
} from "../lib/silence-source";
import route from "../routes/silence-analysis";

const r2Source = {
	url: `https://${"a".repeat(32)}.r2.cloudflarestorage.com/bucket/owner/video/result.mp4?X-Amz-Algorithm=AWS4-HMAC-SHA256&X-Amz-Signature=${"b".repeat(64)}`,
	objectPrefix: "owner/video/",
	identity: '"revision-1"',
	durationMs: 4000,
	contentLength: 1,
};

describe("silence disk reservations", () => {
	test("reserves actual free capacity across requests and releases failed work", async () => {
		const budget = new SilenceDiskBudget(async () => 1024 * 1024 * 1024);
		const first = await budget.reserve("/tmp", 400 * 1024 * 1024);
		await expect(budget.reserve("/tmp", 200 * 1024 * 1024)).rejects.toThrow(
			"disk space",
		);
		first.release();
		first.release();
		const second = await budget.reserve("/tmp", 400 * 1024 * 1024);
		second.release();
	});
	test("detects external disk usage and refuses understated media lengths", async () => {
		let free = 1024 * 1024 * 1024;
		const budget = new SilenceDiskBudget(async () => free);
		const reservation = await budget.reserve("/tmp", 100);
		expect(() => reservation.consume(101)).toThrow("size changed");
		free = 128 * 1024 * 1024;
		await expect(reservation.check()).rejects.toThrow("disk space");
		reservation.release();
	});
});

describe("revision-bound R2 source validation", () => {
	test("rejects nonR2 hosts, local addresses, credentials and wrong object scopes", () => {
		expect(validateSilenceSource(r2Source)).toEqual(r2Source);
		for (const url of [
			"http://127.0.0.1/private",
			"https://r2.cloudflarestorage.com.evil.test/file",
			r2Source.url.replace("https://", "https://user:pass@"),
			r2Source.url.replace("/owner/video/", "/another/video/"),
		])
			expect(() => validateSilenceSource({ ...r2Source, url })).toThrow();
	});
	test("requires matching ETag and disables redirects", async () => {
		const fetchMock = spyOn(globalThis, "fetch").mockResolvedValue(
			new Response(new Uint8Array([1]), { headers: { etag: '"other"' } }),
		);
		try {
			await expect(
				fetchSilenceSource(r2Source, new AbortController().signal),
			).rejects.toThrow("revision");
			expect(fetchMock).toHaveBeenCalledWith(
				r2Source.url,
				expect.objectContaining({
					redirect: "error",
					credentials: "omit",
					headers: { "If-Match": r2Source.identity },
				}),
			);
		} finally {
			fetchMock.mockRestore();
		}
	});
});

function pcm(samples: number[], channels = 1) {
	const bytes = new Uint8Array(samples.length * channels * 4);
	const view = new DataView(bytes.buffer);
	for (let index = 0; index < samples.length; index++)
		for (let channel = 0; channel < channels; channel++)
			view.setFloat32(
				(index * channels + channel) * 4,
				samples[index] ?? 0,
				true,
			);
	return bytes;
}

describe("streamed PCM silence", () => {
	test("handles arbitrarily split byte chunks and preserves source offset", () => {
		const scanner = new SilencePcmScanner(2, 500);
		const bytes = pcm(
			Array.from({ length: 16000 }, () => 0),
			2,
		);
		for (let offset = 0; offset < bytes.length; offset += 101)
			scanner.push(bytes.subarray(offset, offset + 101));
		expect(scanner.finish()).toEqual({
			durationMs: 1000,
			ranges: [{ startMs: 650, endMs: 1350 }],
		});
	});
	test("does not cancel opposite stereo signals or ignore a noisy channel", () => {
		const bytes = new Uint8Array(16000 * 8);
		const view = new DataView(bytes.buffer);
		for (let i = 0; i < 16000; i++) {
			view.setFloat32(i * 8, 0.01, true);
			view.setFloat32(i * 8 + 4, -0.01, true);
		}
		const scanner = new SilencePcmScanner(2);
		scanner.push(bytes);
		expect(scanner.finish().ranges).toEqual([]);
	});
	test("requires complete valid audio, never treating absent data as silence", () => {
		expect(() => new SilencePcmScanner(1).finish()).toThrow();
		const scanner = new SilencePcmScanner(1);
		scanner.push(new Uint8Array(3));
		expect(() => scanner.finish()).toThrow();
		expect(() => new SilencePcmScanner(1).push(pcm([NaN]))).toThrow();
	});
	test("intersects different tracks conservatively", () => {
		expect(
			intersectQuietRanges(
				[{ startMs: 100, endMs: 1000 }],
				[{ startMs: 500, endMs: 1500 }],
			),
		).toEqual([{ startMs: 500, endMs: 1000 }]);
		expect(intersectQuietRanges([{ startMs: 100, endMs: 1000 }], [])).toEqual(
			[],
		);
	});
	test("accepts long audio with bounded chunk storage", () => {
		const scanner = new SilencePcmScanner(1);
		const second = new Uint8Array(16000 * 4);
		for (let i = 0; i < 1801; i++) scanner.push(second);
		expect(scanner.finish().ranges).toEqual([{ startMs: 150, endMs: 1800850 }]);
	});
});

describe("FFmpeg silence integration", () => {
	let directory: string;
	beforeAll(async () => {
		directory = await mkdtemp(join(tmpdir(), "cap-silence-test-"));
	});
	afterAll(async () => {
		await rm(directory, { recursive: true, force: true });
	});
	async function fixture(
		name: string,
		withAudio: boolean,
		extraTrack = false,
		audioDuration = 4,
	) {
		const path = join(directory, name);
		const args = [
			"ffmpeg",
			"-v",
			"error",
			"-f",
			"lavfi",
			"-i",
			"color=c=black:s=16x16:r=10:d=4",
		];
		if (withAudio)
			args.push(
				"-f",
				"lavfi",
				"-i",
				`aevalsrc=if(between(t\\,1\\,2)\\,0.1*sin(2*PI*440*t)\\,0):s=16000:d=${audioDuration}`,
			);
		if (extraTrack)
			args.push(
				"-f",
				"lavfi",
				"-i",
				"sine=frequency=600:sample_rate=16000:duration=4",
			);
		args.push("-map", "0:v");
		if (withAudio) args.push("-map", "1:a");
		if (extraTrack) args.push("-map", "2:a");
		args.push("-c:v", "libx264", "-c:a", "aac", "-y", path);
		const proc = Bun.spawn(args, { stdout: "ignore", stderr: "pipe" });
		const error = await new Response(proc.stderr).text();
		if ((await proc.exited) !== 0) throw new Error(error);
		return path;
	}
	test("analyzes real MP4 audio and excludes audible tone", async () => {
		const result = await analyzeSilenceFile(
			await fixture("audio.mp4", true),
			4000,
			new AbortController().signal,
		);
		expect(result.ranges.length).toBe(2);
		expect(
			result.ranges.every(
				(range) => range.endMs <= 1000 || range.startMs >= 2000,
			),
		).toBe(true);
	});
	test("preserves a second audible track", async () => {
		const result = await analyzeSilenceFile(
			await fixture("multitrack.mp4", true, true),
			4000,
			new AbortController().signal,
		);
		expect(result.audioTracks).toBe(2);
		expect(result.ranges).toEqual([]);
	});
	test("analyzes a desktop video timeline with a slightly longer AAC tail", async () => {
		const result = await analyzeSilenceFile(
			await fixture("aac-tail.mp4", true, false, 4.06),
			4000,
			new AbortController().signal,
		);
		expect(result.durationMs).toBe(4000);
		expect(result.ranges).toHaveLength(2);
		expect(result.ranges.every((range) => range.endMs <= 4000)).toBe(true);
	});
	test("preserves container-based timelines with a slightly shorter video track", async () => {
		const result = await analyzeSilenceFile(
			await fixture("container-aac-tail.mp4", true, false, 4.06),
			4060,
			new AbortController().signal,
		);
		expect(result.durationMs).toBe(4060);
		expect(result.ranges).toHaveLength(2);
	});
	test("rejects audio tails outside the bounded timeline tolerance", async () => {
		await expect(
			analyzeSilenceFile(
				await fixture("long-aac-tail.mp4", true, false, 4.2),
				4000,
				new AbortController().signal,
			),
		).rejects.toThrow("duration");
	});
	test("rejects absent audio, timing mismatch and aborted work", async () => {
		await expect(
			analyzeSilenceFile(
				await fixture("silent-video.mp4", false),
				4000,
				new AbortController().signal,
			),
		).rejects.toThrow("no audio");
		const path = await fixture("mismatch.mp4", true);
		await expect(
			analyzeSilenceFile(path, 5000, new AbortController().signal),
		).rejects.toThrow("duration");
		const controller = new AbortController();
		controller.abort();
		await expect(
			analyzeSilenceFile(path, 4000, controller.signal),
		).rejects.toThrow();
	});
	test("accepts only authenticated media bytes, never caller URLs", async () => {
		process.env.MEDIA_SERVER_WEBHOOK_SECRET = "silence-test-secret";
		expect((await route.request("/", { method: "POST" })).status).toBe(401);
		expect(
			(
				await route.request("/", {
					method: "POST",
					headers: {
						"x-media-server-secret": "silence-test-secret",
						"content-type": "application/json",
					},
					body: JSON.stringify({ url: "http://127.0.0.1/private" }),
				})
			).status,
		).toBe(400);
		const path = await fixture("endpoint.mp4", true);
		const response = await route.request("/", {
			method: "POST",
			headers: {
				"x-media-server-secret": "silence-test-secret",
				"content-type": "video/mp4",
				"x-video-duration-ms": "4000",
				"content-length": `${Bun.file(path).size}`,
			},
			body: Bun.file(path),
		});
		expect(response.status).toBe(200);
		expect((await response.json()).ranges).toHaveLength(2);
	});

	test("streams an R2 object larger than browser and proxy body limits from a small request", async () => {
		process.env.MEDIA_SERVER_WEBHOOK_SECRET = "silence-test-secret";
		const path = await fixture("large-r2.mp4", true);
		const movie = new Uint8Array(await Bun.file(path).arrayBuffer());
		const paddingSize = 129 * 1024 * 1024;
		const header = new Uint8Array(8);
		new DataView(header.buffer).setUint32(0, paddingSize + 8);
		header.set(new TextEncoder().encode("free"), 4);
		const chunk = new Uint8Array(64 * 1024);
		let stage = 0;
		let remaining = paddingSize;
		const body = new ReadableStream<Uint8Array>({
			pull(controller) {
				if (stage++ === 0) controller.enqueue(movie);
				else if (stage === 2) controller.enqueue(header);
				else if (remaining > 0) {
					const size = Math.min(remaining, chunk.length);
					controller.enqueue(chunk.subarray(0, size));
					remaining -= size;
				} else controller.close();
			},
		});
		const contentLength = movie.length + paddingSize + 8;
		const fetchMock = spyOn(globalThis, "fetch").mockResolvedValue(
			new Response(body, {
				headers: {
					etag: r2Source.identity,
					"content-length": `${contentLength}`,
				},
			}),
		);
		try {
			const response = await route.request("/", {
				method: "POST",
				headers: {
					"x-media-server-secret": "silence-test-secret",
					"content-type": "application/json",
				},
				body: JSON.stringify({ ...r2Source, contentLength }),
			});
			expect(response.status).toBe(200);
			expect((await response.json()).ranges).toHaveLength(2);
			expect(remaining).toBe(0);
		} finally {
			fetchMock.mockRestore();
		}
	}, 30_000);
});
