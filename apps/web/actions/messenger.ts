"use server";

import { db } from "@cap/database/cloudflare/application";
import { type AtomicSnapshot, atomic } from "@cap/database/cloudflare/atomic";
import {
	messengerConversations,
	messengerMessages,
	users,
} from "@cap/database/cloudflare/schema";
import { nanoId } from "@cap/database/helpers";
import { buildEnv } from "@cap/env";
import type { User } from "@cap/web-domain";
import { and, asc, desc, eq, isNull, sql } from "drizzle-orm";
import { revalidatePath } from "next/cache";
import { isInstanceAdmin } from "@/lib/instance-admin";
import { generateMessengerAgentReply } from "@/lib/messenger/agent";
import { MESSENGER_AGENT } from "@/lib/messenger/constants";
import {
	getMessengerConversationForViewer,
	getOrCreateAnonymousId,
	getViewerContext,
	linkAnonymousConversationsToUser,
	listAdminMessengerConversations,
	listViewerMessengerConversations,
	requireAdminViewer,
} from "@/lib/messenger/data";
import {
	getIdentityTag,
	storeConversationInSupermemory,
	syncCapKnowledgeBase,
} from "@/lib/messenger/supermemory";
import { sendMessengerSupportEmail } from "@/lib/messenger/support-email";

const normalizeContent = (content: string) => content.trim().slice(0, 6000);

async function requireConversation(
	snapshot: AtomicSnapshot,
	conversationId: string,
	viewer: Awaited<ReturnType<typeof getViewerContext>>,
	anonymousId: string | null,
) {
	const [conversation] = await snapshot.read((reader) =>
		reader
			.select()
			.from(messengerConversations)
			.where(eq(messengerConversations.id, conversationId))
			.limit(1),
	);
	if (!conversation) throw new Error("Conversation not found");
	const matchesUser = Boolean(
		viewer.user && conversation.userId === viewer.user.id,
	);
	const matchesAnonymous = Boolean(
		!conversation.userId &&
			anonymousId &&
			conversation.anonymousId === anonymousId,
	);
	if (!matchesUser && !matchesAnonymous) throw new Error("Unauthorized");
	return conversation;
}

async function requireLiveAdmin(snapshot: AtomicSnapshot, userId: User.UserId) {
	const [user] = await snapshot.read((reader) =>
		reader.select().from(users).where(eq(users.id, userId)).limit(1),
	);
	if (!isInstanceAdmin(user)) throw new Error("Unauthorized");
}

const assertMessengerEnabled = () => {
	if (buildEnv.NEXT_PUBLIC_IS_CAP !== "true") {
		throw new Error("Messenger is disabled");
	}
};

const revalidateMessengerPaths = (conversationId?: string) => {
	revalidatePath("/messenger");
	revalidatePath("/admin");
	if (conversationId) {
		revalidatePath(`/messenger/${conversationId}`);
		revalidatePath(`/admin?conversation=${conversationId}`);
	}
};

const persistConversationToSupermemory = async ({
	conversationId,
	userId,
	anonymousId,
}: {
	conversationId: string;
	userId: string | null;
	anonymousId: string | null;
}) => {
	if (process.env.CAP_RUNTIME === "cloudflare") return;
	const messages = await db()
		.select()
		.from(messengerMessages)
		.where(eq(messengerMessages.conversationId, conversationId))
		.orderBy(asc(messengerMessages.createdAt));
	if (!messages.length) return;

	await storeConversationInSupermemory({
		conversationId,
		containerTag: getIdentityTag(userId, anonymousId),
		messages: messages.map((message: (typeof messages)[number]) => ({
			role: message.role === "user" ? "user" : "assistant",
			content: message.content,
			timestamp: message.createdAt.toISOString(),
		})),
	});
};

export const createMessengerConversation = async () => {
	assertMessengerEnabled();

	const viewer = await getViewerContext();
	const anonymousId = viewer.user
		? viewer.anonymousId
		: await getOrCreateAnonymousId();

	if (viewer.user && viewer.anonymousId) {
		await linkAnonymousConversationsToUser({
			userId: viewer.user.id,
			anonymousId: viewer.anonymousId,
		});
	}

	const whereClause = viewer.user
		? eq(messengerConversations.userId, viewer.user.id)
		: anonymousId
			? and(
					isNull(messengerConversations.userId),
					eq(messengerConversations.anonymousId, anonymousId),
				)
			: null;

	const conversationId = nanoId();
	const database = db();
	const selectedId = await atomic(database, async (snapshot) => {
		if (whereClause) {
			const [latest] = await snapshot.read((reader) =>
				reader
					.select({ id: messengerConversations.id })
					.from(messengerConversations)
					.where(whereClause)
					.orderBy(desc(messengerConversations.createdAt))
					.limit(1),
			);

			if (latest) {
				const [hasMessage] = await snapshot.read((reader) =>
					reader
						.select({ id: messengerMessages.id })
						.from(messengerMessages)
						.where(eq(messengerMessages.conversationId, latest.id))
						.limit(1),
				);

				if (!hasMessage) {
					return { statements: [], result: latest.id };
				}
			}
		}

		const agentId = MESSENGER_AGENT.id;
		return {
			statements: [
				database.insert(messengerConversations).values({
					id: conversationId,
					agent: agentId,
					mode: "agent",
					userId: viewer.user?.id ?? null,
					anonymousId: anonymousId ?? null,
				}),
			],
			result: conversationId,
		};
	});

	revalidateMessengerPaths(selectedId);
	return selectedId;
};

export const sendMessengerUserMessage = async ({
	conversationId,
	content,
}: {
	conversationId: string;
	content: string;
}) => {
	assertMessengerEnabled();
	const normalized = normalizeContent(content);
	if (!conversationId || !normalized) throw new Error("Message is empty");

	const viewer = await getViewerContext();
	const activeAnonymousId = viewer.user
		? viewer.anonymousId
		: (viewer.anonymousId ?? (await getOrCreateAnonymousId()));

	if (viewer.user && activeAnonymousId) {
		await linkAnonymousConversationsToUser({
			userId: viewer.user.id,
			anonymousId: activeAnonymousId,
		});
	}

	const now = new Date();
	const messageId = nanoId();
	const database = db();
	const conversation = await atomic(database, async (snapshot) => {
		const current = await requireConversation(
			snapshot,
			conversationId,
			viewer,
			activeAnonymousId,
		);
		const effectiveUserId = current.userId ?? viewer.user?.id ?? null;
		return {
			statements: [
				database.insert(messengerMessages).values({
					id: messageId,
					conversationId,
					role: "user",
					content: normalized,
					userId: viewer.user?.id ?? null,
					anonymousId: activeAnonymousId ?? null,
					createdAt: now,
				}),
				database
					.update(messengerConversations)
					.set({
						lastMessageAt: sql`max(${messengerConversations.lastMessageAt}, ${now.getTime()})`,
						userId: effectiveUserId,
					})
					.where(eq(messengerConversations.id, conversationId)),
			],
			result: { ...current, userId: effectiveUserId },
		};
	});

	const effectiveUserId = conversation.userId;
	const effectiveAnonymousId =
		conversation.anonymousId ?? activeAnonymousId ?? null;

	if (conversation.mode === "human") {
		await persistConversationToSupermemory({
			conversationId,
			userId: effectiveUserId,
			anonymousId: effectiveAnonymousId,
		}).catch(() => undefined);
		revalidateMessengerPaths(conversationId);
		return { mode: "human" as const };
	}

	const history = await db()
		.select({
			role: messengerMessages.role,
			content: messengerMessages.content,
		})
		.from(messengerMessages)
		.where(eq(messengerMessages.conversationId, conversationId))
		.orderBy(asc(messengerMessages.createdAt));

	const identity = viewer.user
		? `${viewer.user.name ?? "User"} <${viewer.user.email}>`
		: `Anonymous visitor (${effectiveAnonymousId ?? "unknown"})`;
	const supportEmailUser = viewer.user
		? {
				id: viewer.user.id,
				email: viewer.user.email,
				name: viewer.user.name,
			}
		: null;

	const reply = await generateMessengerAgentReply({
		userIdentity: identity,
		identityTag: getIdentityTag(effectiveUserId, effectiveAnonymousId),
		query: normalized,
		history,
		supportEmailTool: supportEmailUser
			? {
					execute: ({ subject, message }) =>
						sendMessengerSupportEmail({
							user: supportEmailUser,
							conversationId,
							subject,
							message,
						}),
				}
			: null,
	});

	const responseAt = new Date();
	const responseId = nanoId();
	const mode = await atomic(database, async (snapshot) => {
		const current = await requireConversation(
			snapshot,
			conversationId,
			viewer,
			activeAnonymousId,
		);
		if (current.mode === "human")
			return { statements: [], result: "human" as const };
		return {
			statements: [
				database.insert(messengerMessages).values({
					id: responseId,
					conversationId,
					role: "agent",
					content: reply,
					userId: null,
					anonymousId: effectiveAnonymousId,
					createdAt: responseAt,
				}),
				database
					.update(messengerConversations)
					.set({
						lastMessageAt: sql`max(${messengerConversations.lastMessageAt}, ${responseAt.getTime()})`,
					})
					.where(eq(messengerConversations.id, conversationId)),
			],
			result: "agent" as const,
		};
	});

	await persistConversationToSupermemory({
		conversationId,
		userId: effectiveUserId,
		anonymousId: effectiveAnonymousId,
	}).catch(() => undefined);

	revalidateMessengerPaths(conversationId);
	return { mode };
};

export const adminSetMessengerMode = async ({
	conversationId,
	mode,
}: {
	conversationId: string;
	mode: "agent" | "human";
}) => {
	assertMessengerEnabled();
	const viewer = await requireAdminViewer();
	const now = new Date();
	if (mode !== "agent" && mode !== "human") throw new Error("Invalid mode");

	const database = db();
	await atomic(database, async (snapshot) => {
		await requireLiveAdmin(snapshot, viewer.user.id);
		const [conversation] = await snapshot.read((reader) =>
			reader
				.select()
				.from(messengerConversations)
				.where(eq(messengerConversations.id, conversationId))
				.limit(1),
		);
		if (!conversation) throw new Error("Conversation not found");
		return {
			statements: [
				database
					.update(messengerConversations)
					.set(
						mode === "human"
							? {
									mode,
									takeoverByUserId: viewer.user.id,
									takeoverAt: now,
								}
							: {
									mode,
									takeoverByUserId: null,
									takeoverAt: null,
								},
					)
					.where(eq(messengerConversations.id, conversationId)),
			],
			result: undefined,
		};
	});

	revalidateMessengerPaths(conversationId);
};

export const adminSendMessengerMessage = async ({
	conversationId,
	content,
}: {
	conversationId: string;
	content: string;
}) => {
	assertMessengerEnabled();
	const viewer = await requireAdminViewer();
	const normalized = normalizeContent(content);
	if (!normalized) throw new Error("Message is empty");

	const now = new Date();
	const messageId = nanoId();
	const database = db();
	const conversation = await atomic(database, async (snapshot) => {
		await requireLiveAdmin(snapshot, viewer.user.id);
		const [current] = await snapshot.read((reader) =>
			reader
				.select()
				.from(messengerConversations)
				.where(eq(messengerConversations.id, conversationId))
				.limit(1),
		);
		if (!current) throw new Error("Conversation not found");
		return {
			statements: [
				database.insert(messengerMessages).values({
					id: messageId,
					conversationId,
					role: "admin",
					content: normalized,
					userId: viewer.user.id,
					anonymousId: current.anonymousId,
					createdAt: now,
				}),
				database
					.update(messengerConversations)
					.set({
						mode: "human",
						takeoverByUserId: viewer.user.id,
						takeoverAt: now,
						lastMessageAt: sql`max(${messengerConversations.lastMessageAt}, ${now.getTime()})`,
					})
					.where(eq(messengerConversations.id, conversationId)),
			],
			result: current,
		};
	});

	await persistConversationToSupermemory({
		conversationId,
		userId: conversation.userId,
		anonymousId: conversation.anonymousId,
	}).catch(() => undefined);

	revalidateMessengerPaths(conversationId);
};

export const adminSyncMessengerKnowledge = async () => {
	assertMessengerEnabled();
	const viewer = await requireAdminViewer();
	const result = await syncCapKnowledgeBase(viewer.user.email);
	revalidatePath("/admin");
	return result;
};

export const fetchMessengerConversations = async () => {
	assertMessengerEnabled();
	const { conversations } = await listViewerMessengerConversations();
	return conversations.map((c) => ({
		id: c.id,
		agent: c.agent,
		latestMessage: c.latestMessage
			? {
					content: c.latestMessage.content,
					createdAt: c.latestMessage.createdAt.toISOString(),
				}
			: null,
		lastMessageAt: c.lastMessageAt?.toISOString() ?? null,
	}));
};

export const fetchMessengerConversation = async (conversationId: string) => {
	assertMessengerEnabled();
	const data = await getMessengerConversationForViewer({ conversationId });
	if (!data) throw new Error("Conversation not found");
	return {
		conversation: {
			id: data.conversation.id,
			agent: data.conversation.agent,
			mode: data.conversation.mode as "agent" | "human",
		},
		messages: data.messages.map((m) => ({
			id: m.id,
			role: m.role as "user" | "agent" | "admin",
			content: m.content,
			createdAt: m.createdAt.toISOString(),
		})),
	};
};

export const fetchAdminConversations = async () => {
	assertMessengerEnabled();
	const { conversations } = await listAdminMessengerConversations();
	return conversations.map((c) => ({
		id: c.id,
		agent: c.agent,
		mode: c.mode as "agent" | "human",
		userId: c.userId,
		anonymousId: c.anonymousId,
		userName: c.userName ?? null,
		userEmail: c.userEmail ?? null,
		lastMessageAt: c.lastMessageAt?.toISOString() ?? null,
		latestMessage: c.latestMessage
			? {
					content: c.latestMessage.content,
					role: c.latestMessage.role as "user" | "agent" | "admin",
					createdAt: c.latestMessage.createdAt.toISOString(),
				}
			: null,
	}));
};

export const fetchAdminConversation = async (conversationId: string) => {
	assertMessengerEnabled();
	await requireAdminViewer();
	const data = await getMessengerConversationForViewer({
		conversationId,
		allowAdmin: true,
	});
	if (!data) throw new Error("Conversation not found");
	return {
		conversation: {
			id: data.conversation.id,
			agent: data.conversation.agent,
			mode: data.conversation.mode as "agent" | "human",
			userId: data.conversation.userId,
			anonymousId: data.conversation.anonymousId,
			userName: data.conversation.userName ?? null,
			userEmail: data.conversation.userEmail ?? null,
		},
		messages: data.messages.map((m) => ({
			id: m.id,
			role: m.role as "user" | "agent" | "admin",
			content: m.content,
			createdAt: m.createdAt.toISOString(),
		})),
	};
};
