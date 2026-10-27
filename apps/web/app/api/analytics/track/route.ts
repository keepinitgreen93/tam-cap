import { isCrossSiteCookieWrite } from "@cap/database/auth/request-site";
import { db } from "@cap/database/cloudflare/application";
import { videos, videoUploads } from "@cap/database/cloudflare/schema";
import { Analytics, provideOptionalAuth, VideosPolicy } from "@cap/web-backend";
import { CurrentUser, Video } from "@cap/web-domain";
import { eq } from "drizzle-orm";
import { Effect, Option } from "effect";
import type { NextRequest } from "next/server";
import UAParser from "ua-parser-js";

import { getAnonymousName } from "@/lib/anonymous-names";
import {
	createAnonymousViewNotification,
	sendFirstViewEmail,
} from "@/lib/Notification";
import { runPromise } from "@/lib/server";

interface TrackPayload {
	videoId: string;
	sessionId?: string;
	eventId?: string;
	userAgent?: string;
	occurredAt?: string;
}

const VIEW_TRACKING_DELAY_MS = 2 * 60 * 1000;
const MAX_CLIENT_CLOCK_SKEW_MS = 5 * 60 * 1000;

const viewTimestamp = (occurredAt: unknown, now: number) => {
	const time =
		typeof occurredAt === "string" ? Date.parse(occurredAt) : Number.NaN;
	return Number.isFinite(time) &&
		Math.abs(time - now) <= MAX_CLIENT_CLOCK_SKEW_MS
		? new Date(time)
		: new Date(now);
};

const sanitizeString = (value?: string | null) => {
	const trimmed = value?.trim();
	return trimmed && trimmed !== "unknown" ? trimmed.slice(0, 256) : undefined;
};

const decodeUrlEncodedHeaderValue = (value?: string | null) => {
	if (!value) return value;
	try {
		return decodeURIComponent(value);
	} catch {
		return value;
	}
};

const unavailableVideo = () => Effect.succeed(Option.none());

export async function POST(request: NextRequest) {
	let body: TrackPayload;
	try {
		const reader = request.body?.getReader();
		if (!reader)
			return Response.json({ error: "Invalid JSON payload" }, { status: 400 });
		const chunks: Uint8Array[] = [];
		let length = 0;
		while (true) {
			const next = await reader.read();
			if (next.done) break;
			length += next.value.byteLength;
			if (length > 16384) {
				await reader.cancel();
				return Response.json({ error: "Payload too large" }, { status: 413 });
			}
			chunks.push(next.value);
		}
		const bytes = new Uint8Array(length);
		let offset = 0;
		for (const chunk of chunks) {
			bytes.set(chunk, offset);
			offset += chunk.byteLength;
		}
		const parsed: unknown = JSON.parse(
			new TextDecoder("utf-8", { fatal: true }).decode(bytes),
		);
		if (
			!parsed ||
			typeof parsed !== "object" ||
			!("videoId" in parsed) ||
			typeof parsed.videoId !== "string" ||
			!/^[A-Za-z0-9_-]{1,64}$/.test(parsed.videoId)
		)
			return Response.json({ error: "videoId is required" }, { status: 400 });
		body = {
			videoId: parsed.videoId,
			sessionId:
				"sessionId" in parsed && typeof parsed.sessionId === "string"
					? parsed.sessionId
					: undefined,
			userAgent:
				"userAgent" in parsed && typeof parsed.userAgent === "string"
					? parsed.userAgent
					: undefined,
			occurredAt:
				"occurredAt" in parsed && typeof parsed.occurredAt === "string"
					? parsed.occurredAt
					: undefined,
			eventId:
				"eventId" in parsed && typeof parsed.eventId === "string"
					? parsed.eventId.slice(0, 128)
					: undefined,
		};
	} catch {
		return Response.json({ error: "Invalid JSON payload" }, { status: 400 });
	}

	const parsedSessionId =
		typeof body.sessionId === "string"
			? body.sessionId.trim().slice(0, 128) || null
			: null;
	const sessionId =
		parsedSessionId && parsedSessionId !== "anonymous" ? parsedSessionId : null;
	const userAgent =
		sanitizeString(request.headers.get("user-agent")) ||
		sanitizeString(body.userAgent) ||
		"unknown";
	const parser = new UAParser(userAgent);
	const browserName = parser.getBrowser().name ?? "unknown";
	const osName = parser.getOS().name ?? "unknown";
	const deviceType = parser.getDevice().type ?? "desktop";

	const timestamp = viewTimestamp(body.occurredAt, Date.now());

	const geoHeader = (field: "country" | "region" | "city") =>
		process.env.CAP_RUNTIME === "cloudflare"
			? `x-cap-geo-${field}`
			: field === "region"
				? "x-vercel-ip-country-region"
				: `x-vercel-ip-${field}`;
	const country =
		sanitizeString(
			decodeUrlEncodedHeaderValue(request.headers.get(geoHeader("country"))),
		) ?? "";
	const region =
		sanitizeString(
			decodeUrlEncodedHeaderValue(request.headers.get(geoHeader("region"))),
		) ?? "";
	const city =
		sanitizeString(
			decodeUrlEncodedHeaderValue(request.headers.get(geoHeader("city"))),
		) ?? "";
	const crossSite = isCrossSiteCookieWrite(request);

	try {
		await runPromise(
			Effect.gen(function* () {
				const maybeUser = yield* Effect.serviceOption(CurrentUser);
				const userId = Option.match(maybeUser, {
					onNone: () => null as string | null,
					onSome: (user) => {
						const currentUser = user as {
							id: string;
							email: string;
							activeOrganizationId: string;
							iconUrlOrKey: Option.Option<unknown>;
						};
						return currentUser.id;
					},
				});

				const ANON_NOTIF_CUTOFF = new Date("2026-03-04T00:00:00Z");

				const [videoRecord] = yield* Effect.tryPromise(() =>
					db()
						.select({
							orgId: videos.orgId,
							ownerId: videos.ownerId,
							firstViewEmailSentAt: videos.firstViewEmailSentAt,
							videoName: videos.name,
							createdAt: videos.createdAt,
							updatedAt: videos.updatedAt,
							activeUploadVideoId: videoUploads.videoId,
							activeUploadPhase: videoUploads.phase,
						})
						.from(videos)
						.leftJoin(videoUploads, eq(videoUploads.videoId, videos.id))
						.where(eq(videos.id, Video.VideoId.make(body.videoId)))
						.limit(1),
				);

				if (!videoRecord || userId === videoRecord.ownerId) {
					return;
				}

				if (
					(videoRecord.activeUploadVideoId &&
						videoRecord.activeUploadPhase !== "complete") ||
					Date.now() - videoRecord.updatedAt.getTime() < VIEW_TRACKING_DELAY_MS
				) {
					return;
				}

				const policy = yield* VideosPolicy;
				const permission = policy
					.getViewableById(Video.VideoId.make(body.videoId))
					.pipe(
						Effect.catchTags({
							PolicyDenied: unavailableVideo,
							VerifyVideoPasswordError: unavailableVideo,
						}),
					);
				const viewable = yield* crossSite
					? permission.pipe(
							Effect.provideService(Video.VideoPasswordAttachment, {
								passwords: [],
							}),
						)
					: permission;
				if (Option.isNone(viewable)) return;
				const analytics = yield* Analytics;
				const inserted = yield* analytics.recordView({
					organizationId: videoRecord.orgId || videoRecord.ownerId,
					videoId: body.videoId,
					sessionId: sessionId ?? "anon",
					occurredAt: timestamp,
					eventId: body.eventId || undefined,
					country,
					region,
					city,
					browser: browserName,
					device: deviceType,
					os: osName,
				});
				if (!inserted) return;

				const isNewVideo = videoRecord.createdAt >= ANON_NOTIF_CUTOFF;
				const shouldSendFirstViewEmail =
					isNewVideo && !videoRecord.firstViewEmailSentAt;

				if (userId) {
					if (shouldSendFirstViewEmail) {
						yield* Effect.forkDaemon(
							Effect.tryPromise(() =>
								sendFirstViewEmail({
									videoId: body.videoId,
									viewerUserId: userId,
									isAnonymous: false,
								}),
							).pipe(
								Effect.catchAll((error) => {
									console.error("Failed to send first view email:", error);
									return Effect.void;
								}),
							),
						);
					}
				}

				if (!userId && sessionId && isNewVideo) {
					const anonName = getAnonymousName(sessionId);
					const location =
						city && country ? `${city}, ${country}` : city || country || null;

					const effects: Effect.Effect<void, never, never>[] = [
						Effect.tryPromise(() =>
							createAnonymousViewNotification({
								videoId: body.videoId,
								sessionId,
								anonName,
								location,
							}),
						).pipe(
							Effect.catchAll((error) => {
								console.error(
									"Failed to create anonymous view notification:",
									error,
								);
								return Effect.void;
							}),
						),
					];

					if (shouldSendFirstViewEmail) {
						effects.push(
							Effect.tryPromise(() =>
								sendFirstViewEmail({
									videoId: body.videoId,
									viewerName: anonName,
									isAnonymous: true,
								}),
							).pipe(
								Effect.catchAll((error) => {
									console.error("Failed to send first view email:", error);
									return Effect.void;
								}),
							),
						);
					}

					yield* Effect.forkDaemon(Effect.all(effects));
				}

				if (!userId && !sessionId && isNewVideo && shouldSendFirstViewEmail) {
					yield* Effect.forkDaemon(
						Effect.tryPromise(() =>
							sendFirstViewEmail({
								videoId: body.videoId,
								viewerName: "Anonymous Viewer",
								isAnonymous: true,
							}),
						).pipe(
							Effect.catchAll((error) => {
								console.error("Failed to send first view email:", error);
								return Effect.void;
							}),
						),
					);
				}
			}).pipe((trackView) =>
				crossSite ? trackView : provideOptionalAuth(trackView),
			),
		);
	} catch {
		return Response.json(
			{ error: "Analytics could not be recorded" },
			{ status: 503 },
		);
	}
	return Response.json({ success: true });
}
