export const CLOUDFLARE_SPEECH_MODEL = "@cf/deepgram/nova-3";

export interface CloudflareTranscriptWord {
	text: string;
	start: number;
	end: number;
	confidence: number | null;
	speaker: string | null;
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

export function parseCloudflareTranscription(
	response: unknown,
	sourceDurationMs?: number,
): CloudflareTranscript {
	const envelope = record(response);
	if (envelope.success !== true) {
		throw new CloudflareTranscriptionError("Cloudflare transcription failed");
	}
	const result = record(envelope.result);
	const metadata = result.metadata === undefined ? {} : record(result.metadata);
	const duration =
		sourceDurationMs === undefined
			? metadata.duration
			: sourceDurationMs / 1000;
	if (!finiteNumber(duration) || duration <= 0) {
		throw new CloudflareTranscriptionError("Invalid Cloudflare audio duration");
	}
	const channels = record(result.results).channels;
	if (!Array.isArray(channels) || channels.length !== 1) {
		throw new CloudflareTranscriptionError(
			"Invalid Cloudflare transcription channels",
		);
	}
	const channel = record(channels[0]);
	const alternatives = channel.alternatives;
	if (!Array.isArray(alternatives) || alternatives.length === 0) {
		throw new CloudflareTranscriptionError(
			"Missing Cloudflare transcription alternative",
		);
	}
	const alternative = record(alternatives[0]);
	if (
		!Array.isArray(alternative.words) ||
		typeof alternative.transcript !== "string"
	) {
		throw new CloudflareTranscriptionError(
			"Missing Cloudflare transcription words",
		);
	}
	if (alternative.words.length === 0 && alternative.transcript.trim()) {
		throw new CloudflareTranscriptionError("Missing Cloudflare word timings");
	}
	const words = alternative.words.map((value): CloudflareTranscriptWord => {
		const word = record(value);
		const text =
			typeof word.punctuated_word === "string"
				? word.punctuated_word
				: word.word;
		if (
			typeof text !== "string" ||
			!text.trim() ||
			!finiteNumber(word.start) ||
			!finiteNumber(word.end) ||
			word.start < 0 ||
			word.end <= word.start ||
			word.end > duration ||
			Math.round(word.end * 1000) <= Math.round(word.start * 1000)
		) {
			throw new CloudflareTranscriptionError("Invalid Cloudflare word timing");
		}
		if (
			word.confidence !== undefined &&
			(!finiteNumber(word.confidence) ||
				word.confidence < 0 ||
				word.confidence > 1)
		) {
			throw new CloudflareTranscriptionError(
				"Invalid Cloudflare word confidence",
			);
		}
		if (
			word.speaker !== undefined &&
			(!finiteNumber(word.speaker) ||
				!Number.isInteger(word.speaker) ||
				word.speaker < 0)
		) {
			throw new CloudflareTranscriptionError("Invalid Cloudflare word speaker");
		}
		return {
			text: text.trim(),
			start: Math.round(word.start * 1000),
			end: Math.round(word.end * 1000),
			confidence:
				word.confidence === undefined ? null : (word.confidence as number),
			speaker: word.speaker === undefined ? null : String(word.speaker),
			channel: "0",
		};
	});
	return {
		id:
			typeof metadata.request_id === "string"
				? metadata.request_id
				: "cloudflare",
		status: words.length ? "completed" : "error",
		...(words.length ? {} : { error: "No spoken audio" }),
		words,
		audio_duration: duration,
		language_code:
			typeof channel.detected_language === "string"
				? channel.detected_language
				: null,
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
	contentType = "audio/mpeg",
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
	if (audio.byteLength === 0) {
		throw new CloudflareTranscriptionError(
			"Empty Cloudflare transcription audio",
		);
	}
	if (!finiteNumber(sourceDurationMs) || sourceDurationMs <= 0) {
		throw new CloudflareTranscriptionError(
			"Missing or invalid source audio duration",
		);
	}
	const endpoint = new URL(
		`https://api.cloudflare.com/client/v4/accounts/${credentials.accountId}/ai/run/${CLOUDFLARE_SPEECH_MODEL}`,
	);
	endpoint.searchParams.set("filler_words", "true");
	endpoint.searchParams.set("punctuate", "true");
	endpoint.searchParams.set("diarize", "true");
	if (language === "auto") {
		endpoint.searchParams.set("detect_language", "true");
	} else {
		endpoint.searchParams.set("language", language);
	}
	let response: Response;
	try {
		response = await fetcher(endpoint, {
			method: "POST",
			headers: {
				Authorization: `Bearer ${credentials.apiToken}`,
				"Content-Type": contentType,
			},
			body: new Uint8Array(audio).buffer,
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
