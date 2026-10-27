"use server";

import { normalizeEmail } from "@cap/database/auth/identity";
import { getCurrentUser } from "@cap/database/auth/session";
import { db } from "@cap/database/cloudflare/application";
import { atomic } from "@cap/database/cloudflare/atomic";
import { videos, videoViewerGrants } from "@cap/database/cloudflare/schema";
import { sendEmail } from "@cap/database/emails/config";
import { VideoViewerInvite } from "@cap/database/emails/video-viewer-invite";
import { nanoId } from "@cap/database/helpers";
import { serverEnv } from "@cap/env";
import {
	activeVideo,
	requireOwnedVideo,
	requireWritableVideo,
} from "@cap/web-backend/src/Videos/persistence";
import type { Video } from "@cap/web-domain";
import { and, eq, isNull } from "drizzle-orm";
import { revalidatePath } from "next/cache";

const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

async function getOwnedVideo(videoId: Video.VideoId) {
	const user = await getCurrentUser();
	if (!user) throw new Error("Unauthorized");

	const [video] = await db()
		.select({ id: videos.id, name: videos.name, ownerId: videos.ownerId })
		.from(videos)
		.where(and(activeVideo, eq(videos.id, videoId)))
		.limit(1);

	if (!video || video.ownerId !== user.id) throw new Error("Unauthorized");
	return { user, video };
}

function validatedEmail(email: string) {
	let normalized: string;
	try {
		normalized = normalizeEmail(email);
	} catch {
		return null;
	}
	if (normalized.length > 254 || !EMAIL_PATTERN.test(normalized)) {
		return null;
	}
	return normalized;
}

export async function getVideoViewerGrants(videoId: Video.VideoId) {
	const { user } = await getOwnedVideo(videoId);
	return atomic(db(), async (snapshot) => {
		await requireOwnedVideo(snapshot, videoId, user.id);
		const grants = await snapshot.read((reader) =>
			reader
				.select({ email: videoViewerGrants.email })
				.from(videoViewerGrants)
				.where(
					and(
						eq(videoViewerGrants.videoId, videoId),
						isNull(videoViewerGrants.revokedAt),
					),
				)
				.orderBy(videoViewerGrants.email),
		);
		return { statements: [], result: grants };
	});
}

export async function inviteVideoViewer(videoId: Video.VideoId, email: string) {
	const { user } = await getOwnedVideo(videoId);
	const normalizedEmail = validatedEmail(email);
	if (!normalizedEmail) {
		return { success: false, error: "Enter a valid email address" } as const;
	}

	const database = db();
	const id = nanoId();
	const now = new Date();
	const claimed = await atomic(database, async (snapshot) => {
		const current = await requireWritableVideo(snapshot, videoId, user.id);
		const [existingGrant] = await snapshot.read((reader) =>
			reader
				.select()
				.from(videoViewerGrants)
				.where(
					and(
						eq(videoViewerGrants.videoId, videoId),
						eq(videoViewerGrants.email, normalizedEmail),
					),
				)
				.limit(1),
		);
		if (existingGrant && !existingGrant.revokedAt)
			return {
				statements: [],
				result: { added: false, id: existingGrant.id, name: current.name },
			};
		return {
			statements: [
				database
					.insert(videoViewerGrants)
					.values({
						id,
						videoId,
						email: normalizedEmail,
						invitedByUserId: user.id,
						createdAt: now,
					})
					.onConflictDoUpdate({
						target: [videoViewerGrants.videoId, videoViewerGrants.email],
						set: { revokedAt: null, invitedByUserId: user.id, createdAt: now },
					}),
			],
			result: { added: true, id: existingGrant?.id ?? id, name: current.name },
		};
	});
	if (!claimed.added)
		return { success: true, alreadyAdded: true, emailSent: false } as const;

	revalidatePath(`/s/${videoId}`);

	let emailSent = false;
	try {
		const result = await sendEmail({
			email: normalizedEmail,
			subject: `Invitation to watch ${claimed.name} on Cap`,
			idempotencyKey: `video-viewer/${claimed.id}/${now.getTime()}`,
			react: VideoViewerInvite({
				email: normalizedEmail,
				videoName: claimed.name,
				url: `${serverEnv().WEB_URL}/s/${videoId}`,
			}),
		});
		emailSent = Boolean(result?.data && !result.error);
		if (result?.error) {
			console.error("Failed to email video viewer invitation:", result.error);
		}
	} catch (error) {
		console.error("Failed to email video viewer invitation:", error);
	}

	return { success: true, alreadyAdded: false, emailSent } as const;
}

export async function revokeVideoViewer(videoId: Video.VideoId, email: string) {
	const { user } = await getOwnedVideo(videoId);
	const normalizedEmail = validatedEmail(email);
	if (!normalizedEmail) throw new Error("Enter a valid email address");
	const database = db();
	const now = new Date();
	await atomic(database, async (snapshot) => {
		await requireWritableVideo(snapshot, videoId, user.id);
		return {
			statements: [
				database
					.update(videoViewerGrants)
					.set({ revokedAt: now })
					.where(
						and(
							eq(videoViewerGrants.videoId, videoId),
							eq(videoViewerGrants.email, normalizedEmail),
							isNull(videoViewerGrants.revokedAt),
						),
					),
			],
			result: undefined,
		};
	});

	revalidatePath(`/s/${videoId}`);
	return { success: true };
}
