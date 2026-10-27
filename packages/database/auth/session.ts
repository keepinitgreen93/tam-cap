import { User } from "@cap/web-domain";
import { eq, type InferSelectModel } from "drizzle-orm";
import { getServerSession } from "next-auth";
import { cache } from "react";
import { db } from "../cloudflare/application.ts";
import { users } from "../cloudflare/schema.ts";
import { authOptions } from "./auth-options";

export const getSession = async () => {
	const session = await getServerSession(authOptions());

	return session;
};

export const getCurrentUser = cache(
	async (): Promise<InferSelectModel<typeof users> | null> => {
		const session = await getServerSession(authOptions());

		const userId =
			session?.user &&
			"id" in session.user &&
			typeof session.user.id === "string"
				? session.user.id
				: null;
		if (!userId) return null;

		const [currentUser] = await db()
			.select()
			.from(users)
			.where(eq(users.id, User.UserId.make(userId)));

		return currentUser ?? null;
	},
);

export const userSelectProps = users.$inferSelect;
