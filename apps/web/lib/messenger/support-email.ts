import "server-only";

import { normalizeEmail } from "@cap/database/auth/identity";
import { db } from "@cap/database/cloudflare/application";
import { atomic } from "@cap/database/cloudflare/atomic";
import {
	messengerConversations,
	messengerSupportEmails,
	users,
} from "@cap/database/cloudflare/schema";
import { sendEmail } from "@cap/database/emails/config";
import { MessengerSupportEmail } from "@cap/database/emails/messenger-support-email";
import { nanoId } from "@cap/database/helpers";
import type { User } from "@cap/web-domain";
import { and, count, eq, gte } from "drizzle-orm";

export const MESSENGER_SUPPORT_EMAIL_DAILY_LIMIT = 2;

type MessengerSupportUser = {
	id: User.UserId;
	email: string;
	name?: string | null;
};

const normalizeSubject = (subject: string, userEmail: string) => {
	const normalized = subject.replace(/\s+/g, " ").trim().slice(0, 140);
	return normalized || `Support request from ${userEmail}`;
};

const normalizeMessage = (message: string) => message.trim().slice(0, 4000);

export const getMessengerSupportEmailDayStart = (now = new Date()) => {
	const start = new Date(now);
	start.setUTCHours(0, 0, 0, 0);
	return start;
};

export const sendMessengerSupportEmail = async ({
	user,
	conversationId,
	subject,
	message,
	now = new Date(),
}: {
	user: MessengerSupportUser;
	conversationId: string;
	subject: string;
	message: string;
	now?: Date;
}) => {
	const normalizedSubject = normalizeSubject(subject, user.email);
	const normalizedMessage = normalizeMessage(message);
	if (!normalizedMessage) {
		throw new Error("Support email message is empty");
	}

	const recipient = normalizeEmail(process.env.CAP_OWNER_EMAIL ?? "");
	const senderDomain = process.env.RESEND_FROM_DOMAIN?.trim();
	if (!senderDomain || !/^[a-z0-9.-]+$/i.test(senderDomain)) {
		throw new Error("Support email sender is not configured");
	}
	const reservationId = nanoId();
	const database = db();
	const reserved = await atomic<
		| { status: "sent"; remainingToday: number }
		| { status: "rate_limited"; remainingToday: 0 }
	>(database, async (snapshot) => {
		const [lockedUser] = await snapshot.read((reader) =>
			reader.select({ id: users.id }).from(users).where(eq(users.id, user.id)),
		);

		if (!lockedUser) {
			throw new Error("Support email user not found");
		}
		const [conversation] = await snapshot.read((reader) =>
			reader
				.select({ id: messengerConversations.id })
				.from(messengerConversations)
				.where(
					and(
						eq(messengerConversations.id, conversationId),
						eq(messengerConversations.userId, user.id),
					),
				)
				.limit(1),
		);
		if (!conversation) throw new Error("Support email conversation not found");

		const [row] = await snapshot.read((reader) =>
			reader
				.select({ value: count() })
				.from(messengerSupportEmails)
				.where(
					and(
						eq(messengerSupportEmails.userId, user.id),
						gte(
							messengerSupportEmails.createdAt,
							getMessengerSupportEmailDayStart(now),
						),
					),
				),
		);
		const sentToday = row?.value ?? 0;

		if (sentToday >= MESSENGER_SUPPORT_EMAIL_DAILY_LIMIT) {
			return {
				statements: [],
				result: {
					status: "rate_limited" as const,
					remainingToday: 0 as const,
				},
			};
		}

		return {
			statements: [
				database.insert(messengerSupportEmails).values({
					id: reservationId,
					conversationId,
					userId: user.id,
					userEmail: user.email,
					subject: normalizedSubject,
					message: normalizedMessage,
					createdAt: now,
				}),
			],
			result: {
				status: "sent" as const,
				remainingToday: Math.max(
					0,
					MESSENGER_SUPPORT_EMAIL_DAILY_LIMIT - sentToday - 1,
				),
			},
		};
	});

	if (reserved.status === "rate_limited") {
		return reserved;
	}

	const delivery = await sendEmail({
		email: recipient,
		subject: `Messenger support: ${normalizedSubject}`,
		react: MessengerSupportEmail({
			userEmail: user.email,
			userName: user.name,
			conversationId,
			message: normalizedMessage,
		}),
		replyTo: user.email,
		fromOverride: `Cap Support <support@${senderDomain}>`,
		idempotencyKey: `support-email-${reservationId}`,
	});
	if (delivery?.error) {
		throw new Error(`Support email was not sent: ${delivery.error.message}`);
	}
	if (!delivery?.data?.id)
		throw new Error("Support email delivery was not confirmed");

	return reserved;
};
