import "server-only";

import { getCurrentUser } from "@cap/database/auth/session";
import { db } from "@cap/database/cloudflare/application";
import { type AtomicSnapshot, atomic } from "@cap/database/cloudflare/atomic";
import {
	messengerConversations,
	messengerMessages,
	users,
} from "@cap/database/cloudflare/schema";
import { nanoIdLong } from "@cap/database/helpers";
import { and, asc, desc, eq, isNull, sql } from "drizzle-orm";
import { cookies } from "next/headers";
import { isInstanceAdmin } from "@/lib/instance-admin";
import { MESSENGER_ANON_COOKIE } from "./constants";

const anonCookieOptions = {
	httpOnly: true,
	sameSite: "lax" as const,
	secure: process.env.NODE_ENV === "production",
	maxAge: 60 * 60 * 24 * 365,
	path: "/",
};

export const getViewerContext = async () => {
	const [user, cookieStore] = await Promise.all([getCurrentUser(), cookies()]);
	const anonymousId = cookieStore.get(MESSENGER_ANON_COOKIE)?.value ?? null;
	const isAdmin = isInstanceAdmin(user);

	return {
		user,
		anonymousId,
		isAdmin,
	};
};

type ViewerContext = Awaited<ReturnType<typeof getViewerContext>>;
type AdminViewerContext = Omit<ViewerContext, "user" | "isAdmin"> & {
	user: NonNullable<ViewerContext["user"]>;
	isAdmin: true;
};

export const getOrCreateAnonymousId = async () => {
	const cookieStore = await cookies();
	const existing = cookieStore.get(MESSENGER_ANON_COOKIE)?.value;
	if (existing) return existing;

	const nextId = nanoIdLong();
	cookieStore.set(MESSENGER_ANON_COOKIE, nextId, anonCookieOptions);
	return nextId;
};

export const linkAnonymousConversationsToUser = async ({
	userId,
	anonymousId,
}: {
	userId: (typeof users.$inferSelect)["id"];
	anonymousId: string | null;
}) => {
	if (!anonymousId) return;

	const database = db();
	await atomic(database, async () => ({
		statements: [
			database
				.update(messengerConversations)
				.set({ userId })
				.where(
					and(
						isNull(messengerConversations.userId),
						eq(messengerConversations.anonymousId, anonymousId),
					),
				),
			database
				.update(messengerMessages)
				.set({ userId })
				.where(
					and(
						isNull(messengerMessages.userId),
						eq(messengerMessages.anonymousId, anonymousId),
						sql`${messengerMessages.conversationId} in (select ${messengerConversations.id} from ${messengerConversations} where ${messengerConversations.userId} = ${userId})`,
					),
				),
		],
		result: undefined,
	}));
};

type ConversationSummaryRow = typeof messengerConversations.$inferSelect & {
	userName?: string | null;
	userEmail?: string | null;
};

type LatestMessageSummary = {
	conversationId: string;
	content: string;
	role: typeof messengerMessages.$inferSelect.role;
	createdAt: Date;
};

const appendLatestMessage = async (
	rows: ConversationSummaryRow[],
	snapshot: AtomicSnapshot,
) => {
	if (!rows.length) {
		return [] as Array<
			ConversationSummaryRow & {
				latestMessage: LatestMessageSummary | null;
			}
		>;
	}

	const messages = await snapshot.read((reader) =>
		reader
			.select({
				conversationId: messengerMessages.conversationId,
				content: messengerMessages.content,
				role: messengerMessages.role,
				createdAt: messengerMessages.createdAt,
			})
			.from(messengerMessages)
			.where(
				sql`${messengerMessages.conversationId} in (select value from json_each(${JSON.stringify(rows.map((row) => row.id))}))`,
			)
			.orderBy(desc(messengerMessages.createdAt)),
	);

	const latestByConversation = new Map<string, LatestMessageSummary>();

	for (const message of messages) {
		if (!latestByConversation.has(message.conversationId)) {
			latestByConversation.set(message.conversationId, message);
		}
	}

	return rows.map((row) => ({
		...row,
		latestMessage: latestByConversation.get(row.id) ?? null,
	}));
};

export const listViewerMessengerConversations = async (limit = 30) => {
	const viewer = await getViewerContext();
	if (viewer.user && viewer.anonymousId) {
		await linkAnonymousConversationsToUser({
			userId: viewer.user.id,
			anonymousId: viewer.anonymousId,
		});
	}

	const whereClause = viewer.user
		? eq(messengerConversations.userId, viewer.user.id)
		: viewer.anonymousId
			? and(
					isNull(messengerConversations.userId),
					eq(messengerConversations.anonymousId, viewer.anonymousId),
				)
			: null;

	if (!whereClause) {
		return {
			viewer,
			conversations: [] as Array<
				ConversationSummaryRow & {
					latestMessage: LatestMessageSummary | null;
				}
			>,
		};
	}

	return atomic(db(), async (snapshot) => {
		const conversations = await snapshot.read((reader) =>
			reader
				.select()
				.from(messengerConversations)
				.where(whereClause)
				.orderBy(desc(messengerConversations.lastMessageAt))
				.limit(limit),
		);

		return {
			statements: [],
			result: {
				viewer,
				conversations: await appendLatestMessage(conversations, snapshot),
			},
		};
	});
};

export const listAdminMessengerConversations = async (limit = 80) => {
	const viewer = await getViewerContext();
	if (!viewer.user || !viewer.isAdmin) throw new Error("Unauthorized");

	const userId = viewer.user.id;
	return atomic(db(), async (snapshot) => {
		const [currentUser] = await snapshot.read((reader) =>
			reader.select().from(users).where(eq(users.id, userId)).limit(1),
		);
		if (!isInstanceAdmin(currentUser)) throw new Error("Unauthorized");
		const rows = await snapshot.read((reader) =>
			reader
				.select({
					id: messengerConversations.id,
					agent: messengerConversations.agent,
					mode: messengerConversations.mode,
					userId: messengerConversations.userId,
					anonymousId: messengerConversations.anonymousId,
					takeoverByUserId: messengerConversations.takeoverByUserId,
					takeoverAt: messengerConversations.takeoverAt,
					createdAt: messengerConversations.createdAt,
					updatedAt: messengerConversations.updatedAt,
					lastMessageAt: messengerConversations.lastMessageAt,
					userName: users.name,
					userEmail: users.email,
				})
				.from(messengerConversations)
				.leftJoin(users, eq(messengerConversations.userId, users.id))
				.orderBy(desc(messengerConversations.lastMessageAt))
				.limit(limit),
		);

		return {
			statements: [],
			result: {
				viewer,
				conversations: await appendLatestMessage(rows, snapshot),
			},
		};
	});
};

export const getMessengerConversationForViewer = async ({
	conversationId,
	allowAdmin = false,
}: {
	conversationId: string;
	allowAdmin?: boolean;
}) => {
	const viewer = await getViewerContext();
	if (viewer.user && viewer.anonymousId) {
		await linkAnonymousConversationsToUser({
			userId: viewer.user.id,
			anonymousId: viewer.anonymousId,
		});
	}

	return atomic(db(), async (snapshot) => {
		const [conversation] = await snapshot.read((reader) =>
			reader
				.select({
					id: messengerConversations.id,
					agent: messengerConversations.agent,
					mode: messengerConversations.mode,
					userId: messengerConversations.userId,
					anonymousId: messengerConversations.anonymousId,
					takeoverByUserId: messengerConversations.takeoverByUserId,
					takeoverAt: messengerConversations.takeoverAt,
					createdAt: messengerConversations.createdAt,
					updatedAt: messengerConversations.updatedAt,
					lastMessageAt: messengerConversations.lastMessageAt,
					userName: users.name,
					userEmail: users.email,
				})
				.from(messengerConversations)
				.leftJoin(users, eq(messengerConversations.userId, users.id))
				.where(eq(messengerConversations.id, conversationId)),
		);

		if (!conversation) return { statements: [], result: null };

		let adminAllowed = false;
		if (allowAdmin && viewer.isAdmin && viewer.user) {
			const userId = viewer.user.id;
			const [currentUser] = await snapshot.read((reader) =>
				reader.select().from(users).where(eq(users.id, userId)).limit(1),
			);
			adminAllowed = isInstanceAdmin(currentUser);
		}
		const matchesUser = Boolean(
			viewer.user && conversation.userId === viewer.user.id,
		);
		const matchesAnonymous = Boolean(
			viewer.anonymousId && conversation.anonymousId === viewer.anonymousId,
		);
		const matchesAnonymousAsSignedInUser = Boolean(
			viewer.user && !conversation.userId && matchesAnonymous,
		);
		const matchesAnonymousAsVisitor = Boolean(
			!viewer.user && !conversation.userId && matchesAnonymous,
		);

		if (
			!adminAllowed &&
			!matchesUser &&
			!matchesAnonymousAsSignedInUser &&
			!matchesAnonymousAsVisitor
		) {
			return { statements: [], result: null };
		}

		const messages = await snapshot.read((reader) =>
			reader
				.select()
				.from(messengerMessages)
				.where(eq(messengerMessages.conversationId, conversation.id))
				.orderBy(asc(messengerMessages.createdAt)),
		);

		return {
			statements: [],
			result: {
				viewer,
				conversation,
				messages,
			},
		};
	});
};

export const requireAdminViewer = async (): Promise<AdminViewerContext> => {
	const viewer = await getViewerContext();
	if (!viewer.user || !viewer.isAdmin) {
		throw new Error("Unauthorized");
	}
	return {
		...viewer,
		user: viewer.user,
		isAdmin: true,
	};
};
