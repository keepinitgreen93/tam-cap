import {
	comments,
	notifications,
	videos,
} from "@cap/database/cloudflare/schema";
import { nanoId } from "@cap/database/helpers";
import { Comment, Video } from "@cap/web-domain";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, expect, it, vi } from "vitest";
import { createTestDatabase } from "../../../../packages/database/cloudflare/test-runtime";
import { createTestOwner } from "../helpers/cloudflare-team";

let fixture: Awaited<ReturnType<typeof createTestDatabase>>;
const mail = vi.hoisted(() =>
	vi.fn(async () => ({ data: { id: "sent" }, error: null })),
);
vi.mock("@cap/database/cloudflare/application", () => ({
	db: () => fixture.database,
}));
vi.mock("@cap/database/emails/config", () => ({ sendEmail: mail }));
vi.mock("@cap/database/emails/new-comment", () => ({
	NewComment: (value: unknown) => value,
}));
vi.mock("@cap/database/emails/first-view", () => ({
	FirstView: (value: unknown) => value,
}));
vi.mock("@cap/env", () => ({
	serverEnv: () => ({
		WEB_URL: "https://videos.example.com",
		NEXTAUTH_SECRET: "test-secret",
	}),
}));

import {
	createAnonymousViewNotification,
	createNotification,
	sendFirstViewEmail,
} from "@/lib/Notification";

beforeAll(async () => {
	fixture = await createTestDatabase();
});
afterAll(async () => fixture.dispose());
async function video() {
	const owner = await createTestOwner(fixture.database);
	const id = Video.VideoId.make(nanoId());
	await fixture.database
		.insert(videos)
		.values({
			id,
			ownerId: owner.id,
			orgId: owner.activeOrganizationId,
			name: "Cap",
			source: { type: "webMP4" },
		});
	return { owner, id };
}
it("deduplicates concurrent authored notifications and sends links on WEB_URL", async () => {
	const value = await video();
	const author = await createTestOwner(fixture.database);
	const commentId = Comment.CommentId.make(nanoId());
	await fixture.database
		.insert(comments)
		.values({
			id: commentId,
			videoId: value.id,
			authorId: author.id,
			type: "text",
			content: "Hello",
		});
	const input = {
		type: "comment" as const,
		videoId: value.id,
		authorId: author.id,
		comment: { id: commentId, content: "Hello" },
	};
	await Promise.all([createNotification(input), createNotification(input)]);
	expect(
		await fixture.database
			.select()
			.from(notifications)
			.where(eq(notifications.videoId, value.id)),
	).toHaveLength(1);
	expect(mail).toHaveBeenCalledTimes(1);
	expect(mail.mock.calls[0]?.[0]).toMatchObject({
		email: value.owner.email,
		react: { url: `https://videos.example.com/s/${value.id}` },
	});
});
it("keeps the anonymous view limit under concurrent distinct sessions", async () => {
	const value = await video();
	for (let start = 0; start < 49; start += 5)
		await fixture.database
			.insert(notifications)
			.values(
				Array.from({ length: Math.min(5, 49 - start) }, (_, index) => ({
					id: nanoId(),
					videoId: value.id,
					orgId: value.owner.activeOrganizationId,
					recipientId: value.owner.id,
					type: "anon_view" as const,
					data: { videoId: value.id, anonName: "Viewer", location: null },
					dedupKey: `seed:${value.id}:${start + index}`,
				})),
			);
	await Promise.all(
		Array.from({ length: 4 }, (_, index) =>
			createAnonymousViewNotification({
				videoId: value.id,
				sessionId: `session-${index}`,
				anonName: "Viewer",
				location: null,
			}),
		),
	);
	expect(
		await fixture.database
			.select()
			.from(notifications)
			.where(eq(notifications.videoId, value.id)),
	).toHaveLength(50);
});
it("reserves the first-view email exactly once despite revision triggers", async () => {
	const value = await video();
	await Promise.all([
		sendFirstViewEmail({
			videoId: value.id,
			viewerName: "Viewer",
			isAnonymous: true,
		}),
		sendFirstViewEmail({
			videoId: value.id,
			viewerName: "Viewer",
			isAnonymous: true,
		}),
	]);
	expect(mail).toHaveBeenCalledTimes(1);
	expect(mail.mock.calls[0]?.[0]).toMatchObject({
		email: value.owner.email,
		react: { url: `https://videos.example.com/s/${value.id}` },
	});
});
