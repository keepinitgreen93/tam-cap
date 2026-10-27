import type { CloudflareDatabase } from "@cap/database/cloudflare";
import {
	getAccountCapability,
	requireWorkspaceAccount,
} from "@cap/database/cloudflare/access";
import { atomic } from "@cap/database/cloudflare/atomic";
import "server-only";

import { randomBytes } from "node:crypto";
import { isBlockedAccountEmail } from "@cap/database/auth/domain-utils";
import { db } from "@cap/database/cloudflare/application";
import {
	mcpOAuthClients,
	mcpOAuthCodes,
	mcpOAuthRegistrationQuotas,
	mcpOAuthTokens,
	users,
} from "@cap/database/cloudflare/schema";
import { nanoId } from "@cap/database/helpers";
import { serverEnv } from "@cap/env";
import { and, eq, gt, isNull } from "drizzle-orm";
import {
	hashAgentSecret,
	isAgentCodeChallenge,
	isAgentCodeVerifier,
	verifyAgentCodeChallenge,
} from "./agent-auth";

export const mcpIssuer = () => new URL(serverEnv().WEB_URL).origin;
export const mcpResource = () => `${mcpIssuer()}/api/mcp`;
export const mcpProtectedResourceMetadataUrl = () =>
	`${mcpIssuer()}/.well-known/oauth-protected-resource/api/mcp`;

const accessLifetimeSeconds = 3_600;
const refreshLifetimeSeconds = 30 * 24 * 3_600;
const dailyRegistrationLimit = 5_000;
const token = (prefix: string) =>
	`${prefix}${randomBytes(32).toString("base64url")}`;

export const isMcpRedirectUri = (value: string) => {
	if (value.length > 512) return false;
	try {
		const url = new URL(value);
		const loopback =
			url.protocol === "http:" &&
			(url.hostname === "localhost" ||
				url.hostname === "127.0.0.1" ||
				url.hostname === "[::1]") &&
			url.port.length > 0;
		return (
			(url.protocol === "https:" || loopback) &&
			url.username === "" &&
			url.password === "" &&
			url.hash === "" &&
			url.toString() === value
		);
	} catch {
		return false;
	}
};

export type McpAuthorizationRequest = {
	clientId: string;
	redirectUri: string;
	codeChallenge: string;
	state: string | null;
	resource: string;
};

export const parseMcpAuthorizationRequest = (
	params: URLSearchParams,
	resource: string,
): McpAuthorizationRequest | null => {
	const clientId = params.get("client_id");
	const redirectUri = params.get("redirect_uri");
	const codeChallenge = params.get("code_challenge");
	const state = params.get("state");
	if (
		!clientId ||
		clientId.length > 128 ||
		!redirectUri ||
		!isMcpRedirectUri(redirectUri) ||
		params.get("response_type") !== "code" ||
		!codeChallenge ||
		!isAgentCodeChallenge(codeChallenge) ||
		params.get("code_challenge_method") !== "S256" ||
		params.get("scope") !== "caps:read" ||
		params.get("resource") !== resource ||
		(state !== null && state.length > 512)
	) {
		return null;
	}
	return { clientId, redirectUri, codeChallenge, state, resource };
};

export const registerMcpClient = async (input: {
	clientName: string;
	redirectUris: string[];
}) => {
	const now = new Date();
	const windowId = now.toISOString().slice(0, 10);
	const clientId = token("cap_mcp_client_");
	const database = db();
	const registrationId = nanoId();
	const accepted = await atomic(database, async (snapshot) => {
		const [quota] = await snapshot.read((reader) =>
			reader
				.select()
				.from(mcpOAuthRegistrationQuotas)
				.where(eq(mcpOAuthRegistrationQuotas.windowId, windowId))
				.limit(1),
		);
		if (quota && quota.registrations >= dailyRegistrationLimit)
			return { statements: [], result: false };
		return {
			statements: [
				quota
					? database
							.update(mcpOAuthRegistrationQuotas)
							.set({ registrations: quota.registrations + 1 })
							.where(eq(mcpOAuthRegistrationQuotas.windowId, windowId))
					: database.insert(mcpOAuthRegistrationQuotas).values({
							windowId,
							registrations: 1,
							expiresAt: new Date(now.getTime() + 3 * 24 * 60 * 60_000),
						}),
				database.insert(mcpOAuthClients).values({
					id: registrationId,
					clientId,
					clientName: input.clientName,
					redirectUris: input.redirectUris,
				}),
			],
			result: true,
		};
	});
	return accepted ? clientId : null;
};

export const getMcpClient = async (clientId: string) => {
	const [client] = await db()
		.select()
		.from(mcpOAuthClients)
		.where(eq(mcpOAuthClients.clientId, clientId))
		.limit(1);
	return client ?? null;
};

export const validateMcpAuthorizationRequest = async (
	params: URLSearchParams,
) => {
	const parsed = parseMcpAuthorizationRequest(params, mcpResource());
	if (!parsed) return null;
	const client = await getMcpClient(parsed.clientId);
	if (!client || !client.redirectUris.includes(parsed.redirectUri)) return null;
	return { ...parsed, clientName: client.clientName };
};

export const createMcpAuthorizationCode = async (
	userId: typeof mcpOAuthCodes.$inferInsert.userId,
	request: McpAuthorizationRequest,
) => {
	const code = token("cap_mcp_code_");
	const database = db();
	const id = nanoId();
	const now = new Date();
	await atomic(database, async (snapshot) => {
		await requireWorkspaceAccount(snapshot, userId);
		const [client] = await snapshot.read((reader) =>
			reader
				.select()
				.from(mcpOAuthClients)
				.where(eq(mcpOAuthClients.clientId, request.clientId))
				.limit(1),
		);
		if (!client || !client.redirectUris.includes(request.redirectUri))
			throw new Error("Client registration expired");
		return {
			statements: [
				database
					.update(mcpOAuthClients)
					.set({ activatedAt: now })
					.where(eq(mcpOAuthClients.clientId, request.clientId)),
				database.insert(mcpOAuthCodes).values({
					id,
					userId,
					clientId: request.clientId,
					codeHash: hashAgentSecret(code),
					codeChallenge: request.codeChallenge,
					redirectUri: request.redirectUri,
					resource: request.resource,
					expiresAt: new Date(now.getTime() + 5 * 60_000),
				}),
			],
			result: undefined,
		};
	});
	return code;
};

type McpTokens = {
	access_token: string;
	refresh_token: string;
	token_type: "Bearer";
	expires_in: number;
	scope: "caps:read";
};
const tokenPair = () => ({
	id: nanoId(),
	access: token("cap_mcp_"),
	refresh: token("cap_mcp_refresh_"),
	now: Date.now(),
});
const mintMcpTokens = (
	database: CloudflareDatabase,
	input: {
		userId: typeof mcpOAuthTokens.$inferInsert.userId;
		clientId: string;
		resource: string;
		familyId: string;
	},
	minted: ReturnType<typeof tokenPair>,
) => ({
	statement: database.insert(mcpOAuthTokens).values({
		id: minted.id,
		...input,
		accessHash: hashAgentSecret(minted.access),
		refreshHash: hashAgentSecret(minted.refresh),
		accessExpiresAt: new Date(minted.now + accessLifetimeSeconds * 1_000),
		refreshExpiresAt: new Date(minted.now + refreshLifetimeSeconds * 1_000),
	}),
	result: {
		access_token: minted.access,
		refresh_token: minted.refresh,
		token_type: "Bearer",
		expires_in: accessLifetimeSeconds,
		scope: "caps:read",
	} satisfies McpTokens,
});
export const exchangeMcpCode = async (params: URLSearchParams) => {
	const code = params.get("code");
	const clientId = params.get("client_id");
	const redirectUri = params.get("redirect_uri");
	const verifier = params.get("code_verifier");
	const resource = params.get("resource");
	if (
		!code ||
		!/^cap_mcp_code_[A-Za-z0-9_-]{43}$/.test(code) ||
		!clientId ||
		!redirectUri ||
		!verifier ||
		!isAgentCodeVerifier(verifier) ||
		resource !== mcpResource()
	)
		return null;
	const database = db();
	const minted = tokenPair();
	const familyId = nanoId();
	return atomic<McpTokens | null>(database, async (snapshot) => {
		const [grant] = await snapshot.read((reader) =>
			reader
				.select()
				.from(mcpOAuthCodes)
				.where(eq(mcpOAuthCodes.codeHash, hashAgentSecret(code)))
				.limit(1),
		);
		const now = new Date();
		if (
			!grant ||
			grant.clientId !== clientId ||
			grant.redirectUri !== redirectUri ||
			grant.resource !== resource ||
			grant.consumedAt ||
			grant.expiresAt <= now ||
			!verifyAgentCodeChallenge(verifier, grant.codeChallenge)
		)
			return { statements: [], result: null };
		if (
			(await getAccountCapability(snapshot, grant.userId)).kind !== "workspace"
		)
			return { statements: [], result: null };
		const next = mintMcpTokens(
			database,
			{ userId: grant.userId, clientId, resource, familyId },
			minted,
		);
		return {
			statements: [
				database
					.update(mcpOAuthCodes)
					.set({ consumedAt: now })
					.where(
						and(
							eq(mcpOAuthCodes.id, grant.id),
							isNull(mcpOAuthCodes.consumedAt),
							gt(mcpOAuthCodes.expiresAt, now),
						),
					),
				next.statement,
			],
			result: next.result,
		};
	});
};
export const refreshMcpTokens = async (params: URLSearchParams) => {
	const refreshToken = params.get("refresh_token");
	const clientId = params.get("client_id");
	const resource = params.get("resource");
	if (
		!refreshToken ||
		!/^cap_mcp_refresh_[A-Za-z0-9_-]{43}$/.test(refreshToken) ||
		!clientId ||
		resource !== mcpResource()
	)
		return null;
	const database = db();
	const minted = tokenPair();
	return atomic<McpTokens | null>(database, async (snapshot) => {
		const [row] = await snapshot.read((reader) =>
			reader
				.select()
				.from(mcpOAuthTokens)
				.where(eq(mcpOAuthTokens.refreshHash, hashAgentSecret(refreshToken)))
				.limit(1),
		);
		if (!row || row.clientId !== clientId || row.resource !== resource)
			return { statements: [], result: null };
		const now = new Date();
		if (row.revokedAt)
			return {
				statements: [
					database
						.update(mcpOAuthTokens)
						.set({ revokedAt: now })
						.where(eq(mcpOAuthTokens.familyId, row.familyId)),
				],
				result: null,
			};
		if (row.refreshExpiresAt <= now) return { statements: [], result: null };
		if ((await getAccountCapability(snapshot, row.userId)).kind !== "workspace")
			return { statements: [], result: null };
		const next = mintMcpTokens(
			database,
			{ userId: row.userId, clientId, resource, familyId: row.familyId },
			minted,
		);
		return {
			statements: [
				database
					.update(mcpOAuthTokens)
					.set({ revokedAt: now })
					.where(
						and(
							eq(mcpOAuthTokens.id, row.id),
							isNull(mcpOAuthTokens.revokedAt),
							gt(mcpOAuthTokens.refreshExpiresAt, now),
						),
					),
				next.statement,
			],
			result: next.result,
		};
	});
};
export const authenticateMcpBearer = async (authorization: string | null) => {
	const match = authorization?.match(/^Bearer (cap_mcp_[A-Za-z0-9_-]{43})$/i);
	if (!match?.[1]) return null;
	const [row] = await db()
		.select({
			userId: mcpOAuthTokens.userId,
			clientId: mcpOAuthTokens.clientId,
			email: users.email,
			accessExpiresAt: mcpOAuthTokens.accessExpiresAt,
			revokedAt: mcpOAuthTokens.revokedAt,
			resource: mcpOAuthTokens.resource,
		})
		.from(mcpOAuthTokens)
		.innerJoin(users, eq(mcpOAuthTokens.userId, users.id))
		.where(eq(mcpOAuthTokens.accessHash, hashAgentSecret(match[1])))
		.limit(1);
	if (
		!row ||
		row.revokedAt ||
		row.accessExpiresAt.getTime() <= Date.now() ||
		row.resource !== mcpResource() ||
		isBlockedAccountEmail(row.email)
	)
		return null;
	return { userId: row.userId, clientId: row.clientId };
};

export const revokeMcpToken = async (tokenValue: string, clientId: string) => {
	const hash = hashAgentSecret(tokenValue);
	const [row] = await db()
		.select({
			familyId: mcpOAuthTokens.familyId,
			clientId: mcpOAuthTokens.clientId,
		})
		.from(mcpOAuthTokens)
		.where(
			/^cap_mcp_refresh_/.test(tokenValue)
				? eq(mcpOAuthTokens.refreshHash, hash)
				: eq(mcpOAuthTokens.accessHash, hash),
		)
		.limit(1);
	if (row?.clientId === clientId) {
		await db()
			.update(mcpOAuthTokens)
			.set({ revokedAt: new Date() })
			.where(eq(mcpOAuthTokens.familyId, row.familyId));
	}
};
