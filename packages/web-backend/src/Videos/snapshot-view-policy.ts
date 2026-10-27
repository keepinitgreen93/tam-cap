import { normalizeEmail } from "@cap/database/auth/identity";
import type { AtomicSnapshot } from "@cap/database/cloudflare/atomic";
import * as Db from "@cap/database/cloudflare/schema";
import { DatabaseError } from "@cap/web-domain";
import { and, eq, isNull } from "drizzle-orm";
import { Effect, Option } from "effect";
import { buildCanViewLoaded, type ViewDecisionDeps } from "./VideosPolicy.ts";

export function snapshotVideoViewPolicy(
	snapshot: AtomicSnapshot,
	video: typeof Db.videos.$inferSelect,
) {
	const attempt = <T>(operation: () => Promise<T>) =>
		Effect.tryPromise({
			try: operation,
			catch: (cause) => new DatabaseError({ cause }),
		});
	const deps: ViewDecisionDeps = {
		repo: {
			hasViewerGrant: (id, email) =>
				attempt(async () => {
					const [row] = await snapshot.read((reader) =>
						reader
							.select({ id: Db.videoViewerGrants.id })
							.from(Db.videoViewerGrants)
							.where(
								and(
									eq(Db.videoViewerGrants.videoId, id),
									eq(Db.videoViewerGrants.email, normalizeEmail(email)),
									isNull(Db.videoViewerGrants.revokedAt),
								),
							)
							.limit(1),
					);
					return Boolean(row);
				}),
		},
		orgsRepo: {
			membershipForVideo: (userId, videoId) =>
				attempt(() =>
					snapshot.read((reader) =>
						reader
							.select({ membershipId: Db.organizationMembers.id })
							.from(Db.organizationMembers)
							.innerJoin(
								Db.sharedVideos,
								eq(
									Db.organizationMembers.organizationId,
									Db.sharedVideos.organizationId,
								),
							)
							.innerJoin(
								Db.organizations,
								eq(Db.organizations.id, Db.sharedVideos.organizationId),
							)
							.where(
								and(
									eq(Db.organizationMembers.userId, userId),
									eq(Db.sharedVideos.videoId, videoId),
									isNull(Db.organizations.tombstoneAt),
								),
							),
					),
				),
			allowedEmailDomain: () =>
				attempt(async () => {
					const [row] = await snapshot.read((reader) =>
						reader
							.select({ domain: Db.organizations.allowedEmailDomain })
							.from(Db.organizations)
							.where(
								and(
									eq(Db.organizations.id, video.orgId),
									isNull(Db.organizations.tombstoneAt),
								),
							)
							.limit(1),
					);
					return Option.fromNullable(row?.domain?.trim() || null);
				}),
		},
		spacesRepo: {
			membershipForVideo: (userId, videoId) =>
				attempt(async () => {
					const [row] = await snapshot.read((reader) =>
						reader
							.select({ membershipId: Db.spaceMembers.id })
							.from(Db.spaceMembers)
							.innerJoin(
								Db.spaceVideos,
								eq(Db.spaceMembers.spaceId, Db.spaceVideos.spaceId),
							)
							.innerJoin(Db.spaces, eq(Db.spaces.id, Db.spaceVideos.spaceId))
							.innerJoin(
								Db.organizations,
								eq(Db.organizations.id, Db.spaces.organizationId),
							)
							.where(
								and(
									eq(Db.spaceMembers.userId, userId),
									eq(Db.spaceVideos.videoId, videoId),
									isNull(Db.organizations.tombstoneAt),
								),
							)
							.limit(1),
					);
					return Option.fromNullable(row);
				}),
			passwordsForVideo: (videoId) =>
				attempt(() =>
					snapshot.read((reader) =>
						reader
							.select({ password: Db.spaces.password })
							.from(Db.spaceVideos)
							.innerJoin(Db.spaces, eq(Db.spaceVideos.spaceId, Db.spaces.id))
							.innerJoin(
								Db.organizations,
								eq(Db.organizations.id, Db.spaces.organizationId),
							)
							.where(
								and(
									eq(Db.spaceVideos.videoId, videoId),
									isNull(Db.organizations.tombstoneAt),
								),
							),
					),
				),
		},
	};
	return buildCanViewLoaded(deps, video, Option.fromNullable(video.password));
}
