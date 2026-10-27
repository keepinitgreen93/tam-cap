import { isCrossSiteCookieWrite } from "@cap/database/auth/request-site";
import { getCurrentUser } from "@cap/database/auth/session";
import { requireActiveOrganization } from "@cap/database/cloudflare/access";
import { db } from "@cap/database/cloudflare/application";
import { atomic } from "@cap/database/cloudflare/atomic";
import { videos } from "@cap/database/cloudflare/schema";
import type { Video } from "@cap/web-domain";
import { eq } from "drizzle-orm";
import { revalidatePath } from "next/cache";

export async function POST(
	request: Request,
	props: RouteContext<"/api/videos/[videoId]/retry-transcription">,
) {
	try {
		const user = isCrossSiteCookieWrite(request)
			? null
			: await getCurrentUser();
		if (!user) {
			return Response.json({ error: "Unauthorized" }, { status: 401 });
		}

		const { videoId } = (await props.params) as { videoId: Video.VideoId };
		if (!videoId) {
			return Response.json({ error: "Video ID is required" }, { status: 400 });
		}

		const database = db();
		const status = await atomic(database, async (snapshot) => {
			const [video] = await snapshot.read((reader) =>
				reader.select().from(videos).where(eq(videos.id, videoId)).limit(1),
			);
			if (!video) return { statements: [], result: 404 };
			if (video.ownerId !== user.id) return { statements: [], result: 403 };
			if (video.orgId) await requireActiveOrganization(snapshot, video.orgId);
			const metadata = { ...video.metadata };
			delete metadata.transcriptionRun;
			delete metadata.liveTranscript;
			delete metadata.editTranscriptBackfill;
			delete metadata.aiGenerationRun;
			delete metadata.aiGenerationStatus;
			return {
				statements: [
					database
						.update(videos)
						.set({ transcriptionStatus: null, metadata })
						.where(eq(videos.id, videoId)),
				],
				result: 200,
			};
		});
		if (status !== 200)
			return Response.json(
				{ error: status === 404 ? "Video not found" : "Unauthorized" },
				{ status },
			);

		revalidatePath(`/s/${videoId}`);

		return Response.json({
			success: true,
			message: "Transcription retry triggered",
		});
	} catch (error) {
		console.error("Error resetting transcription status:", error);
		return Response.json({ error: "Internal server error" }, { status: 500 });
	}
}
