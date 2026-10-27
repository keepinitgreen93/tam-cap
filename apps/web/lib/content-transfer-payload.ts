import { gunzipSync, gzipSync } from "node:zlib";
import type { ContentTransferPayload } from "./content-transfer";

const MAX_PLAN_BYTES = 16 * 1024 * 1024;
const MAX_ENCODED_BYTES = 900_000;
const FORMAT = "cap-content-transfer-v1";

export function encodeContentTransferPayload(payload: ContentTransferPayload) {
	const json = JSON.stringify(payload);
	if (Buffer.byteLength(json) > MAX_PLAN_BYTES)
		throw Error("The transfer plan is too large. Select a smaller folder.");
	const encoded = {
		format: FORMAT,
		encoding: "gzip-base64",
		data: gzipSync(json).toString("base64"),
	};
	if (Buffer.byteLength(JSON.stringify(encoded)) > MAX_ENCODED_BYTES)
		throw Error("The transfer plan is too large. Select a smaller folder.");
	return encoded;
}

export function decodeContentTransferPayload(value: unknown): unknown {
	if (!value || typeof value !== "object" || !("format" in value)) return value;
	if (
		value.format !== FORMAT ||
		!("encoding" in value) ||
		value.encoding !== "gzip-base64" ||
		!("data" in value) ||
		typeof value.data !== "string" ||
		value.data.length > MAX_ENCODED_BYTES ||
		value.data.length % 4 !== 0 ||
		!/^[A-Za-z0-9+/]*={0,2}$/.test(value.data)
	)
		throw Error("Stored content transfer plan is invalid");
	return JSON.parse(
		gunzipSync(Buffer.from(value.data, "base64"), {
			maxOutputLength: MAX_PLAN_BYTES,
		}).toString("utf8"),
	);
}
