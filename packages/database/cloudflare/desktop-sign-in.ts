import { createHash, randomBytes } from "node:crypto";
import type { User } from "@cap/web-domain";
import { and, eq, lt } from "drizzle-orm";
import { requireWorkspaceAccount } from "./access.ts";
import { atomic } from "./atomic.ts";
import type { CloudflareDatabase } from "./index.ts";
import {
	authApiKeys,
	desktopSignInRateLimits,
	desktopSignInRequests,
} from "./schema.ts";

export const DESKTOP_SIGN_IN_LIFETIME_MS = 10 * 60 * 1000;
export const DESKTOP_SIGN_IN_INTERVAL_MS = 3000;
export const desktopSignInIdIsValid = (value: string) =>
	/^[a-f0-9]{64}$/.test(value);
export const desktopSignInChallengeIsValid = (value: string) =>
	/^[A-Za-z0-9_-]{43}$/.test(value);
export const desktopSignInChallenge = (verifier: string) =>
	createHash("sha256").update(verifier).digest("base64url");

export class DesktopSignInError extends Error {
	readonly code: "invalid_request" | "slow_down" | "rate_limited";
	constructor(code: "invalid_request" | "slow_down" | "rate_limited") {
		super(code);
		this.code = code;
	}
}

export async function limitDesktopSignIn(
	database: CloudflareDatabase,
	key: string,
	limit: number,
) {
	const now = Date.now();
	const windowId = `desktop-sign-in:${createHash("sha256").update(key).digest("hex")}:${Math.floor(now / 60000)}`;
	await atomic(database, async (snapshot) => {
		const [quota] = await snapshot.read((reader) =>
			reader
				.select()
				.from(desktopSignInRateLimits)
				.where(eq(desktopSignInRateLimits.windowId, windowId)),
		);
		if (quota && quota.requests >= limit)
			throw new DesktopSignInError("rate_limited");
		return {
			statements: [
				database
					.delete(desktopSignInRateLimits)
					.where(lt(desktopSignInRateLimits.expiresAt, new Date(now))),
				database
					.insert(desktopSignInRateLimits)
					.values({
						windowId,
						requests: 1,
						expiresAt: new Date(now + 120000),
					})
					.onConflictDoUpdate({
						target: desktopSignInRateLimits.windowId,
						set: { requests: (quota?.requests ?? 0) + 1 },
					}),
			],
			result: undefined,
		};
	});
}

export async function startDesktopSignIn(
	database: CloudflareDatabase,
	codeChallenge: string,
) {
	if (!desktopSignInChallengeIsValid(codeChallenge))
		throw new DesktopSignInError("invalid_request");
	const id = randomBytes(32).toString("hex");
	const now = new Date();
	await database.batch([
		database
			.delete(desktopSignInRequests)
			.where(lt(desktopSignInRequests.expiresAt, now)),
		database.insert(desktopSignInRequests).values({
			id,
			codeChallenge,
			expiresAt: new Date(now.getTime() + DESKTOP_SIGN_IN_LIFETIME_MS),
		}),
	]);
	return {
		requestId: id,
		interval: DESKTOP_SIGN_IN_INTERVAL_MS / 1000,
		expiresIn: DESKTOP_SIGN_IN_LIFETIME_MS / 1000,
	};
}

export async function approveDesktopSignIn(
	database: CloudflareDatabase,
	requestId: string,
	userId: User.UserId,
) {
	if (!desktopSignInIdIsValid(requestId))
		throw new DesktopSignInError("invalid_request");
	await atomic(database, async (snapshot) => {
		await requireWorkspaceAccount(snapshot, userId);
		const [request] = await snapshot.read((reader) =>
			reader
				.select()
				.from(desktopSignInRequests)
				.where(eq(desktopSignInRequests.id, requestId)),
		);
		if (!request || request.expiresAt.getTime() <= Date.now() || request.userId)
			throw new DesktopSignInError("invalid_request");
		return {
			statements: [
				database
					.update(desktopSignInRequests)
					.set({ userId })
					.where(eq(desktopSignInRequests.id, requestId)),
			],
			result: undefined,
		};
	});
}

export async function pollDesktopSignIn(
	database: CloudflareDatabase,
	requestId: string,
	verifier: string,
) {
	if (
		!desktopSignInIdIsValid(requestId) ||
		!/^[A-Za-z0-9_-]{43}$/.test(verifier)
	)
		throw new DesktopSignInError("invalid_request");
	const challenge = desktopSignInChallenge(verifier);
	return atomic(database, async (snapshot) => {
		const [request] = await snapshot.read((reader) =>
			reader
				.select()
				.from(desktopSignInRequests)
				.where(
					and(
						eq(desktopSignInRequests.id, requestId),
						eq(desktopSignInRequests.codeChallenge, challenge),
					),
				),
		);
		const now = new Date();
		if (!request || request.expiresAt <= now)
			throw new DesktopSignInError("invalid_request");
		if (
			request.lastPolledAt &&
			now.getTime() - request.lastPolledAt.getTime() <
				DESKTOP_SIGN_IN_INTERVAL_MS - 250
		)
			throw new DesktopSignInError("slow_down");
		if (!request.userId)
			return {
				statements: [
					database
						.update(desktopSignInRequests)
						.set({ lastPolledAt: now })
						.where(eq(desktopSignInRequests.id, requestId)),
				],
				result: { status: "pending" as const },
			};
		await requireWorkspaceAccount(snapshot, request.userId);
		const apiKey = crypto.randomUUID();
		return {
			statements: [
				database
					.delete(desktopSignInRequests)
					.where(eq(desktopSignInRequests.id, requestId)),
				database
					.insert(authApiKeys)
					.values({ id: apiKey, userId: request.userId, source: "desktop" }),
			],
			result: {
				status: "complete" as const,
				api_key: apiKey,
				user_id: request.userId,
			},
		};
	});
}
