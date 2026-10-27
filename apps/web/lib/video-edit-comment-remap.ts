import type { CloudflareDatabase } from "@cap/database/cloudflare";
import { comments } from "@cap/database/cloudflare/schema";
import type { Video } from "@cap/web-domain";
import { and, eq, inArray, sql } from "drizzle-orm";

export function remapCommentTimestamps(
	database: CloudflareDatabase,
	videoId: Video.VideoId,
	changes: ReadonlyArray<{ id: string; timestamp: number | null }>,
	updatedAt: Date,
) {
	const mapping = database.$with("remapped_comments").as(
		database
			.select({
				id: sql<string>`json_extract(value, '$.id')`.as("id"),
				timestamp: sql<number | null>`json_extract(value, '$.timestamp')`.as(
					"timestamp",
				),
			})
			.from(sql`json_each(${JSON.stringify(changes)})`),
	);
	return database
		.with(mapping)
		.update(comments)
		.set({
			updatedAt,
			timestamp: sql`(select ${mapping.timestamp} from ${mapping} where ${mapping.id} = ${comments.id})`,
		})
		.where(
			and(
				eq(comments.videoId, videoId),
				inArray(comments.id, database.select({ id: mapping.id }).from(mapping)),
			),
		);
}
