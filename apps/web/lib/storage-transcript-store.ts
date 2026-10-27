import type { TranscriptObjectStore } from "@cap/database/cloudflare/transcript-publication";
import { Effect, Option } from "effect";

export function createTranscriptStore(bucket: {
	getObject: (key: string) => Effect.Effect<Option.Option<string>, unknown>;
	putObject: (
		key: string,
		value: string,
		fields: { contentType: string },
	) => Effect.Effect<unknown, unknown>;
	deleteObject: (key: string) => Effect.Effect<unknown, unknown>;
}): TranscriptObjectStore {
	return {
		getText: (key) =>
			Effect.runPromise(bucket.getObject(key)).then(Option.getOrNull),
		put: (key, value, contentType) =>
			Effect.runPromise(bucket.putObject(key, value, { contentType })),
		delete: (key) => Effect.runPromise(bucket.deleteObject(key)),
	};
}
