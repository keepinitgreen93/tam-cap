export function encode(value) {
	if (value === undefined) return ["undefined"];
	if (value instanceof Date) return ["date", value.toISOString()];
	if (value instanceof Uint8Array) return ["bytes", Array.from(value)];
	if (typeof value === "bigint") return ["bigint", value.toString()];
	if (typeof value === "number" && !Number.isFinite(value)) {
		return ["number", String(value)];
	}
	if (Array.isArray(value)) return ["array", value.map(encode)];
	if (value && typeof value === "object") {
		return [
			"object",
			Object.entries(value).map(([key, item]) => [key, encode(item)]),
		];
	}
	return ["value", value];
}

export function decode(value) {
	if (!Array.isArray(value)) throw new Error("Invalid workflow transport");
	const [tag, data] = value;
	switch (tag) {
		case "undefined":
			return undefined;
		case "date":
			return new Date(data);
		case "bytes":
			return Uint8Array.from(data);
		case "bigint":
			return BigInt(data);
		case "number":
			return Number(data);
		case "array":
			return data.map(decode);
		case "object":
			return Object.fromEntries(data.map(([key, item]) => [key, decode(item)]));
		case "value":
			return data;
		default:
			throw new Error("Invalid workflow transport tag");
	}
}

export const methods = [
	"delivery.get",
	"delivery.claim",
	"delivery.renew",
	"delivery.finish",
	"delivery.release",
	"runs.get",
	"runs.list",
	"steps.get",
	"steps.list",
	"events.create",
	"events.get",
	"events.list",
	"events.listByCorrelationId",
	"hooks.get",
	"hooks.getByToken",
	"hooks.list",
	"writeToStream",
	"writeToStreamMulti",
	"closeStream",
	"listStreamsByRunId",
	"getStreamChunks",
	"getStreamInfo",
	"queue",
	"getDeploymentId",
];
