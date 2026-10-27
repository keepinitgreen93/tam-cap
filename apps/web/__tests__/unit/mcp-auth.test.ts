import { createHash } from "node:crypto";
import {
	mcpOAuthClients,
	mcpOAuthCodes,
	mcpOAuthRegistrationQuotas,
	mcpOAuthTokens,
} from "@cap/database/cloudflare/schema";
import { eq } from "drizzle-orm";
import {
	afterAll,
	beforeAll,
	beforeEach,
	describe,
	expect,
	it,
	vi,
} from "vitest";
import { createTestDatabase } from "../../../../packages/database/cloudflare/test-runtime.ts";
import { createTestOwner } from "../helpers/cloudflare-team";

vi.mock("server-only", () => ({}));
const state = vi.hoisted(() => ({
	database: undefined as
		| Awaited<ReturnType<typeof createTestDatabase>>["database"]
		| undefined,
}));
vi.mock("@cap/database/cloudflare/application", () => ({
	db: () => {
		if (!state.database) throw new Error("Test database unavailable");
		return state.database;
	},
}));

import {
	createMcpAuthorizationCode,
	exchangeMcpCode,
	isMcpRedirectUri,
	parseMcpAuthorizationRequest,
	refreshMcpTokens,
	registerMcpClient,
} from "@/lib/mcp-auth";

const resource = "https://cap.so/api/mcp";
const verifier = "v".repeat(43);
const challenge = createHash("sha256").update(verifier).digest("base64url");
const callback = "https://chatgpt.com/connector/callback";
let fixture: Awaited<ReturnType<typeof createTestDatabase>>;
let owner: Awaited<ReturnType<typeof createTestOwner>>;
const validRequest = () =>
	new URLSearchParams({
		client_id: "cap_mcp_client_test",
		redirect_uri: callback,
		response_type: "code",
		state: "state-value",
		code_challenge: challenge,
		code_challenge_method: "S256",
		scope: "caps:read",
		resource,
	});
const issue = async () => {
	const clientId = await registerMcpClient({
		clientName: "Chat host",
		redirectUris: [callback],
	});
	if (!clientId) throw new Error("Registration failed");
	const code = await createMcpAuthorizationCode(owner.id, {
		clientId,
		redirectUri: callback,
		codeChallenge: challenge,
		state: null,
		resource,
	});
	return {
		clientId,
		code,
		params: new URLSearchParams({
			code,
			client_id: clientId,
			redirect_uri: callback,
			code_verifier: verifier,
			resource,
		}),
	};
};

describe("MCP OAuth on D1", () => {
	beforeAll(async () => {
		Object.assign(process.env, {
			WEB_URL: "https://cap.so",
			NEXTAUTH_URL: "https://cap.so",
			NEXTAUTH_SECRET: "synthetic-test-secret-that-is-long-enough",
			DATABASE_PROVIDER: "d1",
			CAP_RUNTIME: "cloudflare",
			CAP_AWS_BUCKET: "synthetic",
			CAP_AWS_REGION: "us-east-1",
		});
		fixture = await createTestDatabase();
		state.database = fixture.database;
		owner = await createTestOwner(fixture.database);
	});
	afterAll(async () => fixture?.dispose());
	beforeEach(async () => {
		await fixture.database.batch([
			fixture.database.delete(mcpOAuthTokens),
			fixture.database.delete(mcpOAuthCodes),
			fixture.database.delete(mcpOAuthClients),
			fixture.database.delete(mcpOAuthRegistrationQuotas),
		]);
	});
	it("accepts only secure or explicit loopback redirect URIs", () => {
		expect(isMcpRedirectUri(callback)).toBe(true);
		expect(isMcpRedirectUri("http://127.0.0.1:49152/callback")).toBe(true);
		expect(isMcpRedirectUri("http://localhost:49152/callback")).toBe(true);
		for (const uri of [
			"http://chatgpt.com/connector/callback",
			"http://localhost.evil.example:49152/callback",
			"http://127.0.0.1/callback",
			`${callback}#fragment`,
			"https://user:password@chatgpt.com/callback",
			"javascript:alert(1)",
		])
			expect(isMcpRedirectUri(uri)).toBe(false);
	});
	it("binds authorization to PKCE S256, read scope, and the exact resource", () => {
		expect(
			parseMcpAuthorizationRequest(validRequest(), resource),
		).toMatchObject({
			clientId: "cap_mcp_client_test",
			resource,
			codeChallenge: challenge,
		});
		for (const [key, value] of [
			["code_challenge_method", "plain"],
			["scope", "caps:read caps:write"],
			["resource", "https://cap.so/api/v1"],
			["redirect_uri", "https://attacker.example/callback#fragment"],
		]) {
			const params = validRequest();
			if (key === undefined || value === undefined)
				throw new Error("Invalid test case");
			params.set(key, value);
			expect(parseMcpAuthorizationRequest(params, resource)).toBeNull();
		}
	});
	it("activates the client and grants a code only once across concurrent exchanges", async () => {
		const { clientId, code, params } = await issue();
		expect(code).toMatch(/^cap_mcp_code_[A-Za-z0-9_-]{43}$/);
		const [client] = await fixture.database
			.select()
			.from(mcpOAuthClients)
			.where(eq(mcpOAuthClients.clientId, clientId));
		expect(client?.activatedAt).toBeInstanceOf(Date);
		const outcomes = await Promise.all(
			Array.from({ length: 5 }, () => exchangeMcpCode(params)),
		);
		expect(outcomes.filter(Boolean)).toHaveLength(1);
		expect(outcomes.find(Boolean)?.access_token).toMatch(
			/^cap_mcp_[A-Za-z0-9_-]{43}$/,
		);
		const rows = await fixture.database.select().from(mcpOAuthTokens);
		expect(rows).toHaveLength(1);
		expect(rows[0]?.resource).toBe(resource);
		expect(rows[0]?.accessHash).not.toContain("cap_mcp_");
	});
	it("rejects mismatched resources and verifiers without consuming the valid code", async () => {
		const { params } = await issue();
		params.set("resource", "https://cap.so/api/v1");
		expect(await exchangeMcpCode(params)).toBeNull();
		params.set("resource", resource);
		params.set("code_verifier", "w".repeat(43));
		expect(await exchangeMcpCode(params)).toBeNull();
		params.set("code_verifier", verifier);
		expect(await exchangeMcpCode(params)).not.toBeNull();
	});
	it("rotates tokens atomically and revokes the complete family on replay", async () => {
		const { clientId, params } = await issue();
		const first = await exchangeMcpCode(params);
		if (!first) throw new Error("Token exchange failed");
		const refresh = new URLSearchParams({
			refresh_token: first.refresh_token,
			client_id: clientId,
			resource,
		});
		const second = await refreshMcpTokens(refresh);
		expect(second?.refresh_token).not.toBe(first.refresh_token);
		expect(await refreshMcpTokens(refresh)).toBeNull();
		const family = await fixture.database.select().from(mcpOAuthTokens);
		expect(family).toHaveLength(2);
		expect(family.every((row) => row.revokedAt instanceof Date)).toBe(true);
	});
	it("registration quota stays bounded under concurrent writers", async () => {
		const windowId = new Date().toISOString().slice(0, 10);
		await fixture.database.insert(mcpOAuthRegistrationQuotas).values({
			windowId,
			registrations: 4998,
			expiresAt: new Date("2030-01-01"),
		});
		const outcomes = await Promise.all(
			Array.from({ length: 6 }, () =>
				registerMcpClient({
					clientName: "Chat host",
					redirectUris: [callback],
				}),
			),
		);
		expect(outcomes.filter(Boolean)).toHaveLength(2);
		const [quota] = await fixture.database
			.select()
			.from(mcpOAuthRegistrationQuotas);
		expect(quota?.registrations).toBe(5000);
	});
	it("keeps OAuth response contracts for unsafe registration and unsupported grants", async () => {
		const { POST } = await import("@/app/api/mcp/oauth/register/route");
		const response = await POST(
			new Request("https://cap.so/api/mcp/oauth/register", {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({
					redirect_uris: ["http://attacker.example/callback"],
				}),
			}),
		);
		expect(response.status).toBe(400);
		const { POST: token } = await import("@/app/api/mcp/oauth/token/route");
		const unsupported = await token(
			new Request("https://cap.so/api/mcp/oauth/token", {
				method: "POST",
				headers: { "Content-Type": "application/x-www-form-urlencoded" },
				body: "grant_type=client_credentials",
			}),
		);
		expect(unsupported.status).toBe(400);
		expect(await unsupported.json()).toEqual({
			error: "unsupported_grant_type",
		});
		expect(unsupported.headers.get("cache-control")).toBe("no-store");
	});
});
