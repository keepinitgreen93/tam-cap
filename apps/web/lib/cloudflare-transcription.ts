import {
	type AudioChunk,
	indexMp3Frames,
	mp3DurationMs,
	splitMp3,
} from "./mp3-chunks";

export const CLOUDFLARE_SPEECH_MODEL = "@cf/openai/whisper-large-v3-turbo";

export interface CloudflareTranscriptWord {
	text: string;
	start: number;
	end: number;
	confidence: number | null;
	speaker: null;
	channel: string;
}

export interface CloudflareTranscript {
	id: string;
	status: "completed" | "error";
	error?: string;
	words: CloudflareTranscriptWord[];
	audio_duration: number;
	language_code: string | null;
	speech_model_used: string;
}

export class CloudflareTranscriptionError extends Error {
	readonly retryable: boolean;

	constructor(message: string, retryable = false) {
		super(message);
		this.name = "CloudflareTranscriptionError";
		this.retryable = retryable;
	}
}

function record(value: unknown): Record<string, unknown> {
	if (!value || typeof value !== "object" || Array.isArray(value)) {
		throw new CloudflareTranscriptionError(
			"Invalid Cloudflare transcription response",
		);
	}
	return value as Record<string, unknown>;
}

function finiteNumber(value: unknown): value is number {
	return typeof value === "number" && Number.isFinite(value);
}

function confidence(value: unknown): number | null {
	if (value === undefined) return null;
	if (!finiteNumber(value) || value < 0 || value > 1) {
		throw new CloudflareTranscriptionError(
			"Invalid Cloudflare word confidence",
		);
	}
	return value;
}

export function parseCloudflareTranscription(
	response: unknown,
	sourceDurationMs?: number,
): CloudflareTranscript {
	const envelope = record(response);
	if (envelope.success !== true) {
		throw new CloudflareTranscriptionError("Cloudflare transcription failed");
	}
	const result = record(envelope.result);
	const info =
		result.transcription_info === undefined
			? {}
			: record(result.transcription_info);
	const duration =
		sourceDurationMs === undefined ? info.duration : sourceDurationMs / 1000;
	if (!finiteNumber(duration) || duration <= 0) {
		throw new CloudflareTranscriptionError("Invalid Cloudflare audio duration");
	}
	if (typeof result.text !== "string" || !Array.isArray(result.segments)) {
		throw new CloudflareTranscriptionError(
			"Missing Cloudflare transcription segments",
		);
	}
	if (info.language_probability !== undefined)
		confidence(info.language_probability);
	const words: CloudflareTranscriptWord[] = [];
	for (const value of result.segments) {
		const segment = record(value);
		if (typeof segment.text !== "string" || !Array.isArray(segment.words)) {
			throw new CloudflareTranscriptionError("Missing Cloudflare word timings");
		}
		if (segment.words.length === 0 && segment.text.trim()) {
			throw new CloudflareTranscriptionError("Missing Cloudflare word timings");
		}
		for (const value of segment.words) {
			const word = record(value);
			if (
				typeof word.word !== "string" ||
				!word.word.trim() ||
				!finiteNumber(word.start) ||
				!finiteNumber(word.end) ||
				word.start < 0 ||
				word.end < word.start ||
				word.end > duration ||
				(word.end !== word.start &&
					Math.round(word.end * 1000) <= Math.round(word.start * 1000))
			) {
				throw new CloudflareTranscriptionError(
					"Invalid Cloudflare word timing",
				);
			}
			const suppliedConfidence = confidence(word.confidence);
			const pointTiming = word.end === word.start;
			// Whisper can emit real words with zero-width timings. Keep a display marker, never an automatic cut target.
			const end = pointTiming
				? Math.min(Math.round(duration * 1000), Math.round(word.end * 1000) + 1)
				: Math.round(word.end * 1000);
			words.push({
				text: word.word.trim(),
				start: pointTiming
					? Math.max(0, end - 1)
					: Math.round(word.start * 1000),
				end,
				confidence: pointTiming ? 0 : suppliedConfidence,
				speaker: null,
				channel: "0",
			});
		}
	}
	if (!words.length && result.text.trim()) {
		throw new CloudflareTranscriptionError("Missing Cloudflare word timings");
	}
	return {
		id: "cloudflare",
		status: words.length ? "completed" : "error",
		...(words.length ? {} : { error: "No spoken audio" }),
		words,
		audio_duration: duration,
		language_code: typeof info.language === "string" ? info.language : null,
		speech_model_used: CLOUDFLARE_SPEECH_MODEL,
	};
}

async function requestCloudflareTranscription(
	audio: Uint8Array,
	language: string,
	credentials: { accountId?: string; apiToken?: string },
	fetcher: (
		input: RequestInfo | URL,
		init?: RequestInit,
	) => Promise<Response> = fetch,
	_contentType = "audio/mpeg",
	sourceDurationMs?: number,
): Promise<CloudflareTranscript> {
	if (
		!credentials.accountId ||
		!/^[a-f0-9]{32}$/i.test(credentials.accountId) ||
		!credentials.apiToken?.trim()
	) {
		throw new CloudflareTranscriptionError(
			"Missing or invalid Cloudflare transcription credentials",
		);
	}
	if (audio.byteLength === 0)
		throw new CloudflareTranscriptionError(
			"Empty Cloudflare transcription audio",
		);
	if (!finiteNumber(sourceDurationMs) || sourceDurationMs <= 0) {
		throw new CloudflareTranscriptionError(
			"Missing or invalid source audio duration",
		);
	}
	const endpoint = `https://api.cloudflare.com/client/v4/accounts/${credentials.accountId}/ai/run/${CLOUDFLARE_SPEECH_MODEL}`;
	let response: Response;
	try {
		response = await fetcher(endpoint, {
			method: "POST",
			headers: {
				Authorization: `Bearer ${credentials.apiToken}`,
				"Content-Type": "application/json",
			},
			body: JSON.stringify({
				audio: Buffer.from(audio).toString("base64"),
				task: "transcribe",
				vad_filter: true,
				initial_prompt:
					"Um, uh, erm, er. A verbatim transcript preserves every spoken word, including hesitations and filler sounds.",
				...(language === "auto" ? {} : { language }),
			}),
			redirect: "error",
			signal: AbortSignal.timeout(120_000),
		});
	} catch {
		throw new CloudflareTranscriptionError(
			"Cloudflare transcription request failed",
			true,
		);
	}
	if (!response.ok) {
		throw new CloudflareTranscriptionError(
			`Cloudflare transcription HTTP ${response.status}`,
			response.status === 429 || response.status >= 500,
		);
	}
	let result: unknown;
	try {
		result = await response.json();
	} catch {
		throw new CloudflareTranscriptionError(
			"Invalid Cloudflare transcription JSON",
		);
	}
	return parseCloudflareTranscription(result, sourceDurationMs);
}

type Fetcher = (
	input: RequestInfo | URL,
	init?: RequestInit,
) => Promise<Response>;

/**
 * One Whisper call is limited by the 120 second request timeout, and Whisper
 * needs about 4-5 seconds per audio minute, so a single request cannot cover a
 * recording longer than roughly 20 minutes (a 21 minute recording failed four
 * times in a row). Longer audio is cut into short frame-aligned pieces that
 * are transcribed in parallel, which also shortens ordinary recordings.
 */
export const CLOUDFLARE_CHUNK_THRESHOLD_MS = 270_000;
export const CLOUDFLARE_CHUNK_MS = 180_000;
export const CLOUDFLARE_CHUNK_OVERLAP_MS = 2_000;
export const CLOUDFLARE_CHUNK_CONCURRENCY = 4;
const CLOUDFLARE_CHUNK_ATTEMPTS = 2;
const CHUNK_DURATION_SLACK_MS = 2_000;

async function transcribeChunk(
	chunk: AudioChunk,
	language: string,
	credentials: { accountId?: string; apiToken?: string },
	fetcher: Fetcher,
): Promise<CloudflareTranscript> {
	const durationMs = chunk.endMs - chunk.startMs + CHUNK_DURATION_SLACK_MS;
	for (let attempt = 1; ; attempt++) {
		try {
			return await requestCloudflareTranscription(
				chunk.audio,
				language,
				credentials,
				fetcher,
				"audio/mpeg",
				durationMs,
			);
		} catch (error) {
			if (
				!(error instanceof CloudflareTranscriptionError) ||
				!error.retryable ||
				attempt >= CLOUDFLARE_CHUNK_ATTEMPTS
			)
				throw error;
		}
	}
}

async function transcribeChunked(
	chunks: AudioChunk[],
	language: string,
	credentials: { accountId?: string; apiToken?: string },
	fetcher: Fetcher,
	sourceDurationMs: number,
): Promise<CloudflareTranscript> {
	const results: CloudflareTranscript[] = new Array(chunks.length);
	let nextIndex = 0;
	let chunkLanguage = language;
	if (language === "auto") {
		// Detect the language once so every piece is decoded in the same language.
		const first = await transcribeChunk(
			chunks[0] as AudioChunk,
			language,
			credentials,
			fetcher,
		);
		results[0] = first;
		nextIndex = 1;
		if (first.language_code) chunkLanguage = first.language_code;
	}
	const workers = Array.from(
		{
			length: Math.min(CLOUDFLARE_CHUNK_CONCURRENCY, chunks.length - nextIndex),
		},
		async () => {
			while (nextIndex < chunks.length) {
				const index = nextIndex++;
				results[index] = await transcribeChunk(
					chunks[index] as AudioChunk,
					chunkLanguage,
					credentials,
					fetcher,
				);
			}
		},
	);
	await Promise.all(workers);

	const words: CloudflareTranscriptWord[] = [];
	for (const [index, result] of results.entries()) {
		const chunk = chunks[index] as AudioChunk;
		for (const word of result.words) {
			const start = word.start + Math.round(chunk.startMs);
			const end = word.end + Math.round(chunk.startMs);
			const middle = (start + end) / 2;
			if (middle < chunk.coreStartMs || middle >= chunk.coreEndMs) continue;
			if (start >= sourceDurationMs) continue;
			const clampedEnd = Math.min(end, sourceDurationMs);
			words.push({
				...word,
				start: Math.min(start, clampedEnd - 1),
				end: clampedEnd,
			});
		}
	}
	words.sort((a, b) => a.start - b.start || a.end - b.end);
	return {
		id: "cloudflare",
		status: words.length ? "completed" : "error",
		...(words.length ? {} : { error: "No spoken audio" }),
		words,
		audio_duration: sourceDurationMs / 1000,
		language_code:
			results.find((result) => result.language_code)?.language_code ?? null,
		speech_model_used: CLOUDFLARE_SPEECH_MODEL,
	};
}

export async function transcribeWithCloudflare(
	audio: Uint8Array,
	language: string,
	credentials: { accountId?: string; apiToken?: string },
	fetcher: Fetcher = fetch,
	contentType = "audio/mpeg",
	sourceDurationMs?: number,
): Promise<CloudflareTranscript> {
	if (
		finiteNumber(sourceDurationMs) &&
		sourceDurationMs > CLOUDFLARE_CHUNK_THRESHOLD_MS &&
		audio.byteLength > 0 &&
		credentials.accountId &&
		/^[a-f0-9]{32}$/i.test(credentials.accountId) &&
		credentials.apiToken?.trim()
	) {
		const frames = indexMp3Frames(audio);
		// Only split a stream that really covers the recording; otherwise word
		// times could not be placed on its timeline.
		if (
			frames &&
			Math.abs(mp3DurationMs(frames) - sourceDurationMs) <=
				Math.max(5_000, sourceDurationMs * 0.02)
		) {
			return transcribeChunked(
				splitMp3(
					audio,
					frames,
					CLOUDFLARE_CHUNK_MS,
					CLOUDFLARE_CHUNK_OVERLAP_MS,
				),
				language,
				credentials,
				fetcher,
				sourceDurationMs,
			);
		}
	}
	return requestCloudflareTranscription(
		audio,
		language,
		credentials,
		fetcher,
		contentType,
		sourceDurationMs,
	);
}
