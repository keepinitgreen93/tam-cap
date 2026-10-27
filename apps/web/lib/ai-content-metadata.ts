import { videos } from "@cap/database/cloudflare/schema";
import { type SQL, sql } from "drizzle-orm";

export function setGeneratedAiContent(
	metadata: SQL,
	field: "summary" | "chapters",
	value: string | { title: string; start: number }[],
) {
	const path = `$.${field}`;
	const editedPath = `$.${field}ManuallyEdited`;
	// Empty values are deliberate removals. clearAiMetadata in edit-video.ts
	// deletes the keys on media replacement, allowing regeneration despite old flags.
	return sql`CASE WHEN
		json_extract(${videos.metadata}, ${editedPath}) IN (1, 'true')
		AND json_type(${videos.metadata}, ${path}) IS NOT NULL
		THEN ${metadata}
		ELSE json_set(${metadata}, ${path}, json(${JSON.stringify(value)}), ${editedPath}, json('false'))
	END`;
}
