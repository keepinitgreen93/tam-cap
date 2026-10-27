import { z } from "zod";

export const silenceSourceSchema = z
	.object({
		url: z.string().url().max(16_384),
		objectPrefix: z.string().regex(/^[a-zA-Z0-9_-]+\/[a-zA-Z0-9_-]+\/$/),
		identity: z
			.string()
			.max(150)
			.regex(/^"[^"\r\n]+"$/),
		durationMs: z.number().int().positive().finite(),
		contentLength: z
			.number()
			.int()
			.positive()
			.finite()
			.max(64 * 1024 * 1024 * 1024),
	})
	.strict();

export function validateSilenceSource(input: unknown) {
	const source = silenceSourceSchema.parse(input);
	const url = new URL(source.url);
	const path = decodeURIComponent(url.pathname);
	if (
		url.protocol !== "https:" ||
		!/^[a-f0-9]{32}(?:\.(?:eu|fedramp))?\.r2\.cloudflarestorage\.com$/.test(
			url.hostname,
		) ||
		url.port ||
		url.username ||
		url.password ||
		url.hash ||
		path.includes("..") ||
		path.includes("\\") ||
		path.includes("\0") ||
		!path.split("/").slice(2).join("/").startsWith(source.objectPrefix) ||
		url.searchParams.get("X-Amz-Algorithm") !== "AWS4-HMAC-SHA256" ||
		!/^[a-f0-9]{64}$/i.test(url.searchParams.get("X-Amz-Signature") ?? "")
	)
		throw new Error("Silence input must be an authorized signed R2 object");
	return source;
}

export async function fetchSilenceSource(input: unknown, signal: AbortSignal) {
	const source = validateSilenceSource(input);
	const response = await fetch(source.url, {
		headers: { "If-Match": source.identity },
		redirect: "error",
		credentials: "omit",
		signal,
	});
	if (
		!response.ok ||
		!response.body ||
		response.headers.get("etag") !== source.identity ||
		Number(response.headers.get("content-length")) !== source.contentLength
	) {
		await response.body?.cancel();
		throw new Error("Video revision could not be downloaded");
	}
	return response;
}
