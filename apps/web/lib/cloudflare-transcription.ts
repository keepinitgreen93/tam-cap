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
				word.end <= word.start ||
				word.end > duration ||
				Math.round(word.end * 1000) <= Math.round(word.start * 1000)
			) {
				throw new CloudflareTranscriptionError(
					"Invalid Cloudflare word timing",
				);
			}
			words.push({
				text: word.word.trim(),
				start: Math.round(word.start * 1000),
				end: Math.round(word.end * 1000),
				confidence: confidence(word.confidence),
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

export async function transcribeWithCloudflare(
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
