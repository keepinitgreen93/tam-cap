import { createCloudflareDb } from "@cap/database/cloudflare";
import {
	createD1BridgeBinding,
	handleD1BridgeRequest,
} from "@cap/database/cloudflare/bridge";
import {
	messengerConversations,
	messengerMessages,
	type users,
} from "@cap/database/cloudflare/schema";
import { nanoId } from "@cap/database/helpers";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, expect, it, vi } from "vitest";
import { createTestDatabase } from "../../../../packages/database/cloudflare/test-runtime";
import { createTestOwner } from "../helpers/cloudflare-team";

let fixture: Awaited<ReturnType<typeof createTestDatabase>>;
let database: ReturnType<typeof createCloudflareDb>;
let actor: typeof users.$inferSelect | null = null;
let anonymousId: string | null = null;
let beforeReply: (() => Promise<void>) | null = null;
vi.mock("server-only", () => ({}));
vi.mock("@cap/database/cloudflare/application", () => ({
	db: () => database,
}));
vi.mock("@cap/database/auth/session", () => ({
	getCurrentUser: async () => actor,
}));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
vi.mock("next/headers", () => ({
	cookies: async () => ({
		get: () => (anonymousId ? { value: anonymousId } : undefined),
		set: (_name: string, value: string) => {
			anonymousId = value;
		},
	}),
}));
vi.mock("@cap/env", async (original) => ({
	...(await original<typeof import("@cap/env")>()),
	buildEnv: { NEXT_PUBLIC_IS_CAP: "true" },
}));
vi.mock("@/lib/messenger/agent", () => ({
	generateMessengerAgentReply: async () => {
		await beforeReply?.();
		return "AI reply";
	},
}));
vi.mock("@/lib/messenger/support-email", () => ({
	sendMessengerSupportEmail: vi.fn(),
}));

import {
	adminSendMessengerMessage,
	adminSetMessengerMode,
	createMessengerConversation,
	sendMessengerUserMessage,
} from "@/actions/messenger";
import {
	getMessengerConversationForViewer,
	linkAnonymousConversationsToUser,
} from "@/lib/messenger/data";

beforeAll(async () => {
	fixture = await createTestDatabase();
}, 120000);
afterAll(async () => fixture.dispose());
beforeEach(() => {
	database = fixture.database;
	vi.unstubAllEnvs();
	vi.stubEnv("CAP_RUNTIME", "cloudflare");
	actor = null;
	anonymousId = null;
	beforeReply = null;
});

it("rechecks read authorization when an anonymous conversation is adopted while messages load", async () => {
	anonymousId = nanoId();
	const id = await createMessengerConversation();
	const owner = await createTestOwner(fixture.database);
	let injected = false;
	database = createCloudflareDb(
		createD1BridgeBinding({
			fetch: async (request) => {
				const body = await request.clone().text();
				if (!injected && body.includes("messenger_messages")) {
					injected = true;
					await fixture.database
						.update(messengerConversations)
						.set({ userId: owner.id })
						.where(eq(messengerConversations.id, id));
					await fixture.database.insert(messengerMessages).values({
						id: nanoId(),
						conversationId: id,
						role: "user",
						userId: owner.id,
						content: "Private account message",
					});
				}
				return handleD1BridgeRequest(request, fixture.binding);
			},
		}),
	);
	expect(
		await getMessengerConversationForViewer({ conversationId: id }),
	).toBeNull();
	expect(injected).toBe(true);
});

it("creates one reusable empty conversation under concurrent requests", async () => {
	actor = await createTestOwner(fixture.database);
	const ids = await Promise.all([
		createMessengerConversation(),
		createMessengerConversation(),
	]);
	expect(ids[0]).toBe(ids[1]);
	expect(
		await fixture.database
			.select()
			.from(messengerConversations)
			.where(eq(messengerConversations.userId, actor.id)),
	).toHaveLength(1);
});

it("denies anonymous message writes and avoids reusing a conversation after account adoption", async () => {
	anonymousId = nanoId();
	const id = await createMessengerConversation();
	const owner = await createTestOwner(fixture.database);
	await linkAnonymousConversationsToUser({ userId: owner.id, anonymousId });
	await expect(
		sendMessengerUserMessage({ conversationId: id, content: "Forbidden" }),
	).rejects.toThrow("Unauthorized");
	expect(await createMessengerConversation()).not.toBe(id);
	expect(
		await fixture.database
			.select()
			.from(messengerMessages)
			.where(eq(messengerMessages.conversationId, id)),
	).toHaveLength(0);
});

it("commits the user message and conversation update together and skips AI publication after human takeover", async () => {
	actor = await createTestOwner(fixture.database);
	vi.stubEnv("CAP_OWNER_EMAIL", actor.email);
	const id = await createMessengerConversation();
	beforeReply = async () => {
		await adminSetMessengerMode({ conversationId: id, mode: "human" });
	};
	expect(
		await sendMessengerUserMessage({ conversationId: id, content: "Question" }),
	).toEqual({ mode: "human" });
	const messages = await fixture.database
		.select()
		.from(messengerMessages)
		.where(eq(messengerMessages.conversationId, id));
	expect(messages.map((message) => message.role)).toEqual(["user"]);
	const [conversation] = await fixture.database
		.select()
		.from(messengerConversations)
		.where(eq(messengerConversations.id, id));
	expect(conversation).toMatchObject({
		mode: "human",
		takeoverByUserId: actor.id,
	});
});

it("rolls back the message when the conversation update fails", async () => {
	actor = await createTestOwner(fixture.database);
	const id = await createMessengerConversation();
	await fixture.binding
		.prepare(
			`CREATE TRIGGER reject_messenger_update BEFORE UPDATE ON messenger_conversations BEGIN SELECT RAISE(ABORT, 'reject messenger'); END`,
		)
		.run();
	try {
		await expect(
			sendMessengerUserMessage({ conversationId: id, content: "Rolled back" }),
		).rejects.toThrow("reject messenger");
		expect(
			await fixture.database
				.select()
				.from(messengerMessages)
				.where(eq(messengerMessages.conversationId, id)),
		).toHaveLength(0);
	} finally {
		await fixture.binding.prepare("DROP TRIGGER reject_messenger_update").run();
	}
});

it("publishes administrator messages and takeover atomically and denies non-owner admins", async () => {
	actor = await createTestOwner(fixture.database);
	vi.stubEnv("CAP_OWNER_EMAIL", actor.email);
	const id = await createMessengerConversation();
	await adminSendMessengerMessage({
		conversationId: id,
		content: "Owner reply",
	});
	expect(
		(
			await fixture.database
				.select()
				.from(messengerMessages)
				.where(eq(messengerMessages.conversationId, id))
		)[0],
	).toMatchObject({ role: "admin", content: "Owner reply", userId: actor.id });
	actor = await createTestOwner(fixture.database);
	await expect(
		adminSetMessengerMode({ conversationId: id, mode: "agent" }),
	).rejects.toThrow("Unauthorized");
	expect(
		(
			await fixture.database
				.select()
				.from(messengerConversations)
				.where(eq(messengerConversations.id, id))
		)[0]?.mode,
	).toBe("human");
});
