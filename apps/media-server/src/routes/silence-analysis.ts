import { createWriteStream } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { Readable, Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import { Hono } from "hono";
import { validateMediaServerSecret } from "../lib/auth";
import { canAcceptNewVideoProcess } from "../lib/job-manager";
import {
	getIdleTimeoutSeconds,
	isDraining,
	setRequestIdleTimeout,
} from "../lib/lifecycle";
import {
	canAcceptNewAudioOperation,
	withMediaOperation,
} from "../lib/media-operations";
import { analyzeSilenceFile } from "../lib/silence-analysis";
import { silenceDiskBudget } from "../lib/silence-disk";
import {
	fetchSilenceSource,
	validateSilenceSource,
} from "../lib/silence-source";
import { ensureTempDir, getTempDir, retainTempPath } from "../lib/temp-files";
import { tryAcquireDirectVideoProcessSlot } from "../lib/video-capacity";

const route = new Hono();
let activeAnalyses = 0;
const configuredConcurrency = Number(
	process.env.MEDIA_SERVER_MAX_CONCURRENT_SILENCE_ANALYSES ?? 1,
);
const maxConcurrency = Number.isInteger(configuredConcurrency)
	? Math.max(1, Math.min(configuredConcurrency, 4))
	: 1;

route.post("/", async (c) => {
	if (!validateMediaServerSecret(c))
		return c.json({ error: "Unauthorized" }, 401);
	let remoteSource: ReturnType<typeof validateSilenceSource> | null = null;
	if (c.req.header("content-type") === "application/json") {
		try {
			remoteSource = validateSilenceSource(await c.req.json());
		} catch {
			return c.json({ error: "Invalid signed media source" }, 400);
		}
	}
	const durationMs =
		remoteSource?.durationMs ?? Number(c.req.header("x-video-duration-ms"));
	const contentLength =
		remoteSource?.contentLength ?? Number(c.req.header("content-length"));
	if (
		(!remoteSource && c.req.header("content-type") !== "video/mp4") ||
		!c.req.raw.body ||
		!Number.isSafeInteger(durationMs) ||
		durationMs <= 0 ||
		!Number.isSafeInteger(contentLength) ||
		contentLength <= 0
	)
		return c.json({ error: "Invalid analysis input" }, 400);
	if (
		isDraining() ||
		!canAcceptNewAudioOperation() ||
		activeAnalyses >= maxConcurrency
	)
		return c.json({ error: "Analysis capacity is busy" }, 503);
	const slot = tryAcquireDirectVideoProcessSlot(canAcceptNewVideoProcess);
	if (!slot) return c.json({ error: "Analysis capacity is busy" }, 503);
	activeAnalyses++;
	setRequestIdleTimeout(c.env, c.req.raw, 0);
	const controller = new AbortController();
	const signal = AbortSignal.any([
		c.req.raw.signal,
		controller.signal,
		AbortSignal.timeout(6 * 60 * 60 * 1000),
	]);
	try {
		const result = await withMediaOperation("audio", async (setCancel) => {
			setCancel(() => controller.abort());
			await ensureTempDir();
			const directory = await mkdtemp(join(getTempDir(), "silence-"));
			const releaseTemp = retainTempPath(directory);
			let reservation:
				| Awaited<ReturnType<typeof silenceDiskBudget.reserve>>
				| undefined;
			try {
				reservation = await silenceDiskBudget.reserve(directory, contentLength);
				const disk = reservation;
				const path = join(directory, "input.mp4");
				const input = remoteSource
					? (await fetchSilenceSource(remoteSource, signal)).body
					: c.req.raw.body;
				if (!input) throw new Error("Missing media stream");
				let bytes = 0;
				let checkedAt = 0;
				const limit = new Transform({
					transform(chunk: Buffer, _encoding, callback) {
						try {
							disk.consume(chunk.length);
						} catch (error) {
							callback(
								error instanceof Error
									? error
									: new Error("Disk reservation failed"),
							);
							return;
						}
						bytes += chunk.length;
						if (bytes - checkedAt >= 16 * 1024 * 1024) {
							checkedAt = bytes;
							void disk.check().then(
								() => callback(null, chunk),
								(error: Error) => callback(error),
							);
						} else callback(null, chunk);
					},
				});
				await pipeline(
					Readable.fromWeb(
						input as unknown as Parameters<typeof Readable.fromWeb>[0],
					),
					limit,
					createWriteStream(path, { flags: "wx" }),
					{ signal },
				);
				if (bytes !== contentLength)
					throw new Error("Media size changed during silence analysis");
				return await analyzeSilenceFile(path, durationMs, signal);
			} finally {
				try {
					await rm(directory, { recursive: true, force: true });
				} finally {
					reservation?.release();
					releaseTemp();
				}
			}
		});
		return c.json(result);
	} catch (error) {
		console.error(
			"[silence-analysis] Analysis failed",
			error instanceof Error ? error.message : "Unknown error",
		);
		return c.json(
			{ error: "Audio analysis failed. No cuts were created." },
			422,
		);
	} finally {
		activeAnalyses--;
		slot.release();
		setRequestIdleTimeout(c.env, c.req.raw, getIdleTimeoutSeconds());
	}
});

export default route;
