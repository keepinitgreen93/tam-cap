"use server";

import { getCurrentUser } from "@cap/database/auth/session";
import { requireActiveOrganization } from "@cap/database/cloudflare/access";
import { db } from "@cap/database/cloudflare/application";
import { atomic } from "@cap/database/cloudflare/atomic";
import { videos } from "@cap/database/cloudflare/schema";
import { Storage } from "@cap/web-backend";
import type { Video } from "@cap/web-domain";
import { eq } from "drizzle-orm";
import { Option } from "effect";
import { revalidatePath } from "next/cache";
import { runPromise } from "@/lib/server";
import {
	metadataWithTranscriptPublication,
	type PreparedTranscriptPublication,
	prepareTranscriptPublication,
	readTranscriptArtifacts,
	readTranscriptPublicationOutcome,
	TranscriptPublicationConflictError,
} from "@/lib/transcript-publication";
import { updateVttEntryText } from "@/lib/transcript-vtt";
import { decodeStorageVideo } from "@/lib/video-storage";

export async function editTranscriptEntry(
	videoId: Video.VideoId,
	entryId: number,
	newText: string,
): Promise<{ success: boolean; message: string }> {
	const user = await getCurrentUser();

	if (!user || !videoId || entryId === undefined || !newText?.trim()) {
		return {
			success: false,
			message: "Missing required data for updating transcript entry",
		};
	}

	const userId = user.id;
	const query = await db()
		.select({ video: videos })
		.from(videos)
		.where(eq(videos.id, videoId));

	if (query.length === 0) {
		return { success: false, message: "Video not found" };
	}

	const result = query[0];
	if (!result?.video) {
		return { success: false, message: "Video information is missing" };
	}

	const { video } = result;

	if (video.ownerId !== userId) {
		return {
			success: false,
			message: "You don't have permission to edit this transcript",
		};
	}

	const [bucket] = await Storage.getAccessForVideo(
		decodeStorageVideo(video),
	).pipe(runPromise);

	const store = {
		getText: async (key: string) =>
			Option.getOrNull(await bucket.getObject(key).pipe(runPromise)),
		put: (key: string, value: string, contentType: string) =>
			bucket.putObject(key, value, { contentType }).pipe(runPromise),
		delete: (key: string) => bucket.deleteObject(key).pipe(runPromise),
	};
	let prepared: PreparedTranscriptPublication | undefined;
	try {
		const artifacts = await readTranscriptArtifacts(video, store);
		if (artifacts.vtt === null)
			return { success: false, message: "Transcript file not found" };
		const { content: updatedVttContent, updated } = updateVttEntryText(
			artifacts.vtt,
			entryId,
			newText,
		);
		if (!updated)
			return { success: false, message: "Transcript entry not found" };
		prepared = await prepareTranscriptPublication({
			video,
			store,
			vtt: updatedVttContent,
			editTranscript: artifacts.editTranscript,
		});
		const candidate = prepared;
		const database = db();
		await atomic(database, async (snapshot) => {
			const [current] = await snapshot.read((reader) =>
				reader.select().from(videos).where(eq(videos.id, videoId)),
			);
			if (!current || current.ownerId !== user.id)
				throw new TranscriptPublicationConflictError();
			if (current.orgId)
				await requireActiveOrganization(snapshot, current.orgId);
			return {
				statements: [
					database
						.update(videos)
						.set({
							metadata: metadataWithTranscriptPublication(current, candidate),
							transcriptionStatus: "COMPLETE",
						})
						.where(eq(videos.id, videoId)),
				],
				result: undefined,
			};
		});

		revalidatePath(`/s/${videoId}`);

		return {
			success: true,
			message: "Transcript entry updated successfully",
		};
	} catch (error) {
		if (prepared) {
			const outcome = await readTranscriptPublicationOutcome(db(), prepared);
			if (outcome.state === "published") {
				revalidatePath(`/s/${videoId}`);
				return {
					success: true,
					message: "Transcript entry updated successfully",
				};
			}
		}
		console.error("Error updating transcript entry:", {
			error: error instanceof Error ? error.message : error,
			videoId,
			entryId,
			userId,
		});
		return {
			success: false,
			message: "Failed to update transcript entry",
		};
	}
}
