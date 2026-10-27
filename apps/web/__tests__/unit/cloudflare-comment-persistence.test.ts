import { createCloudflareDb } from "@cap/database/cloudflare";
import {
	createD1BridgeBinding,
	handleD1BridgeRequest,
} from "@cap/database/cloudflare/bridge";
import * as Db from "@cap/database/cloudflare/schema";
import {
	Comment,
	CurrentUser,
	Organisation,
	User,
	Video,
} from "@cap/web-domain";
import { eq } from "drizzle-orm";
import { Effect, Option } from "effect";
import { afterAll, beforeAll, expect, it, vi } from "vitest";
import { insertComment } from "@/lib/comment-persistence";
import { createTestDatabase } from "../../../../packages/database/cloudflare/test-runtime";

vi.mock("@cap/env", () => ({ buildEnv: { NEXT_PUBLIC_IS_CAP: "true" } }));
let runtime: Awaited<ReturnType<typeof createTestDatabase>>;
let database: ReturnType<typeof createCloudflareDb>;
let beforeBatch: (() => Promise<void>) | undefined;
let sequence = 0;
beforeAll(async () => {
	runtime = await createTestDatabase();
	database = createCloudflareDb(
		createD1BridgeBinding({
			fetch: async (request) => {
				const payload = (await request.clone().json()) as { operation: string };
				if (payload.operation === "batch" && beforeBatch) {
					const action = beforeBatch;
					beforeBatch = undefined;
					await action();
				}
				return handleD1BridgeRequest(request, runtime.binding);
			},
		}),
	);
}, 60000);
afterAll(async () => runtime?.dispose());
async function fixture() {
	const suffix = String(++sequence),
		ownerId = User.UserId.make(`cowner${suffix}`),
		guestId = User.UserId.make(`cguest${suffix}`),
		orgId = Organisation.OrganisationId.make(`corg${suffix}`),
		videoId = Video.VideoId.make(`cvideo${suffix}`),
		id = Comment.CommentId.make(`comment${suffix}`),
		email = `guest${suffix}@comments.test`;
	await runtime.database.insert(Db.users).values([
		{
			id: ownerId,
			email: `owner${suffix}@comments.test`,
			stripeSubscriptionStatus: "active",
			activeOrganizationId: orgId,
		},
		{ id: guestId, email, activeOrganizationId: orgId },
	]);
	await runtime.database
		.insert(Db.organizations)
		.values({ id: orgId, ownerId, name: "Comments" });
	await runtime.database
		.insert(Db.videos)
		.values({
			id: videoId,
			orgId,
			ownerId,
			public: false,
			source: { type: "webMP4" },
		});
	const value = {
		id,
		videoId,
		authorId: guestId,
		type: "text" as const,
		content: "Comment",
		timestamp: null,
	};
	const authorize = (
		policy: Parameters<Parameters<typeof insertComment>[2]["authorize"]>[0],
		passwords: string[] = [],
	) =>
		Effect.runPromise(
			policy.pipe(
				Effect.provideService(CurrentUser, {
					id: guestId,
					email,
					activeOrganizationId: orgId,
					iconUrlOrKey: Option.none(),
				}),
				Effect.provideService(Video.VideoPasswordAttachment, { passwords }),
			),
		);
	const grant = () =>
		runtime.database
			.insert(Db.videoViewerGrants)
			.values({
				id: `grant${suffix}`,
				videoId,
				email,
				invitedByUserId: ownerId,
			});
	return { value, authorize, grant, ownerId, orgId, guestId };
}
it("private comments require an active viewer grant", async () => {
	const f = await fixture();
	await expect(
		insertComment(database, f.value, { authorize: f.authorize }),
	).rejects.toThrow();
	await f.grant();
	expect(
		await insertComment(database, f.value, { authorize: f.authorize }),
	).toEqual({ created: true });
});
it("grant revocation racing insertion denies the entire comment", async () => {
	const f = await fixture();
	await f.grant();
	beforeBatch = async () => {
		await runtime.database
			.update(Db.videoViewerGrants)
			.set({ revokedAt: new Date() })
			.where(eq(Db.videoViewerGrants.videoId, f.value.videoId));
	};
	await expect(
		insertComment(database, f.value, { authorize: f.authorize }),
	).rejects.toThrow();
	expect(
		await runtime.database
			.select()
			.from(Db.comments)
			.where(eq(Db.comments.id, f.value.id)),
	).toEqual([]);
});
it("organization deletion racing comment insertion leaves no comment", async () => {
	const f = await fixture();
	await f.grant();
	beforeBatch = async () => {
		await runtime.database
			.update(Db.organizations)
			.set({ tombstoneAt: new Date() })
			.where(eq(Db.organizations.id, f.orgId));
	};
	await expect(
		insertComment(database, f.value, { authorize: f.authorize }),
	).rejects.toThrow();
	expect(
		await runtime.database
			.select()
			.from(Db.comments)
			.where(eq(Db.comments.id, f.value.id)),
	).toEqual([]);
});
it("reply-parent deletion racing insertion rolls back the reply", async () => {
	const f = await fixture();
	await f.grant();
	const parent = Comment.CommentId.make(`parent${sequence}`);
	await runtime.database.insert(Db.comments).values({ ...f.value, id: parent });
	beforeBatch = async () => {
		await runtime.database
			.delete(Db.comments)
			.where(eq(Db.comments.id, parent));
	};
	await expect(
		insertComment(
			database,
			{ ...f.value, parentCommentId: parent },
			{ authorize: f.authorize },
		),
	).rejects.toThrow("Comment not found");
	expect(
		await runtime.database
			.select()
			.from(Db.comments)
			.where(eq(Db.comments.id, f.value.id)),
	).toEqual([]);
});
it("a parent from another video cannot attach a reply", async () => {
	const f = await fixture(),
		other = await fixture();
	await f.grant();
	await runtime.database.insert(Db.comments).values(other.value);
	await expect(
		insertComment(
			database,
			{ ...f.value, parentCommentId: other.value.id },
			{ authorize: f.authorize },
		),
	).rejects.toThrow("Comment not found");
});
it("a media capability is single-use and retries do not create another comment", async () => {
	const f = await fixture();
	await f.grant();
	const options = {
		authorize: f.authorize,
		mediaVideo: {
			ownerId: f.ownerId,
			bucketId: Option.none(),
			storageIntegrationId: Option.none(),
		},
	};
	const value = {
		...f.value,
		type: "video" as const,
		mediaKey: `${f.ownerId}/${f.value.videoId}/comments/${f.value.id}/media.webm`,
		mediaDuration: 5,
		mediaMeta: { mime: "video/webm", size: 42 },
	};
	const results = await Promise.all([
		insertComment(database, value, options),
		insertComment(database, value, options),
	]);
	expect(results.filter((result) => result.created)).toHaveLength(1);
	await expect(
		insertComment(database, { ...value, content: "Different" }, options),
	).rejects.toThrow("already used");
	expect(
		await runtime.database
			.select()
			.from(Db.comments)
			.where(eq(Db.comments.id, f.value.id)),
	).toHaveLength(1);
});
it("media comments recheck the owner's entitlement inside their publication snapshot", async () => {
	const f = await fixture();
	await f.grant();
	beforeBatch = async () => {
		await runtime.database
			.update(Db.users)
			.set({ stripeSubscriptionStatus: null })
			.where(eq(Db.users.id, f.ownerId));
	};
	await expect(
		insertComment(
			database,
			{ ...f.value, type: "video", mediaKey: "key", mediaDuration: 5 },
			{
				authorize: f.authorize,
				mediaVideo: {
					ownerId: f.ownerId,
					bucketId: Option.none(),
					storageIntegrationId: Option.none(),
				},
			},
		),
	).rejects.toThrow("not available");
});
it("viewer grants still require the current verified video password", async () => {
	const f = await fixture();
	await f.grant();
	await runtime.database
		.update(Db.videos)
		.set({ password: "verified-password-hash" })
		.where(eq(Db.videos.id, f.value.videoId));
	await expect(
		insertComment(database, f.value, { authorize: f.authorize }),
	).rejects.toThrow();
	expect(
		await insertComment(database, f.value, {
			authorize: (policy) => f.authorize(policy, ["verified-password-hash"]),
		}),
	).toEqual({ created: true });
});
