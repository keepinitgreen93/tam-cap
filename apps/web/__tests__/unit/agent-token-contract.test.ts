import { createHash } from "node:crypto";
import {
	agentApiAuthorizationCodes,
	agentApiKeys,
} from "@cap/database/cloudflare/schema";
import { Agent, DatabaseError } from "@cap/web-domain";
import { Effect } from "effect";
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
import { CloudflareDatabase } from "../../../../packages/web-backend/src/CloudflareDatabase";
import { createTestOwner } from "../helpers/cloudflare-team";

vi.mock("server-only", () => ({}));
vi.mock("@cap/web-backend", async () => ({
	CloudflareDatabase: (
		await import("../../../../packages/web-backend/src/CloudflareDatabase")
	).CloudflareDatabase,
}));

import {
	exchangeAgentAuthorizationCode,
	revokeAgentAccessToken,
} from "@/lib/agent-token";

let fixture: Awaited<ReturnType<typeof createTestDatabase>>;
let owner: Awaited<ReturnType<typeof createTestOwner>>;
const code = "c".repeat(43);
const verifier = "v".repeat(43);
const redirectUri = "http://127.0.0.1:49152/callback";
const hash = (value: string) =>
	createHash("sha256").update(value).digest("hex");
const run = <A, E>(effect: Effect.Effect<A, E, CloudflareDatabase>) => {
	const service = CloudflareDatabase.make({
		use: (callback) =>
			Effect.tryPromise({
				try: () => callback(fixture.database),
				catch: (cause) => new DatabaseError({ cause }),
			}),
	});
	return Effect.runPromise(
		effect.pipe(Effect.provideService(CloudflareDatabase, service)),
	);
};

describe("agent token storage on D1", () => {
	beforeAll(async () => {
		fixture = await createTestDatabase();
		owner = await createTestOwner(fixture.database);
	});
	afterAll(async () => fixture?.dispose());
	beforeEach(async () => {
		await fixture.database.batch([
			fixture.database.delete(agentApiKeys),
			fixture.database.delete(agentApiAuthorizationCodes),
		]);
		await fixture.database.insert(agentApiAuthorizationCodes).values({
			id: "agent-grant",
			userId: owner.id,
			codeHash: hash(code),
			codeChallenge: createHash("sha256").update(verifier).digest("base64url"),
			redirectUri,
			scopes: ["caps:read"],
			expiresAt: new Date(Date.now() + 60_000),
		});
	});
	it("consumes a PKCE-bound code exactly once across concurrent exchanges", async () => {
		const results = await Promise.allSettled(
			Array.from({ length: 5 }, () =>
				run(
					exchangeAgentAuthorizationCode(
						{ code, codeVerifier: verifier, redirectUri },
						"request-id",
					),
				),
			),
		);
		expect(
			results.filter((result) => result.status === "fulfilled"),
		).toHaveLength(1);
		expect(await fixture.database.select().from(agentApiKeys)).toHaveLength(1);
		const [grant] = await fixture.database
			.select()
			.from(agentApiAuthorizationCodes);
		expect(grant?.consumedAt).toBeInstanceOf(Date);
	});
	it("stores only hashes of authorization codes and access tokens", async () => {
		const issued = await run(
			exchangeAgentAuthorizationCode(
				{ code, codeVerifier: verifier, redirectUri },
				"request-id",
			),
		);
		const [key] = await fixture.database.select().from(agentApiKeys);
		expect(key?.tokenHash).toBe(hash(issued.accessToken));
		expect(JSON.stringify(key)).not.toContain(issued.accessToken);
		const [grant] = await fixture.database
			.select()
			.from(agentApiAuthorizationCodes);
		expect(grant?.codeHash).toBe(hash(code));
	});
	it("does not consume a grant for the wrong verifier or redirect", async () => {
		await expect(
			run(
				exchangeAgentAuthorizationCode(
					{ code, codeVerifier: "w".repeat(43), redirectUri },
					"request-id",
				),
			),
		).rejects.toThrow();
		await expect(
			run(
				exchangeAgentAuthorizationCode(
					{
						code,
						codeVerifier: verifier,
						redirectUri: "http://127.0.0.1:49153/callback",
					},
					"request-id",
				),
			),
		).rejects.toThrow();
		expect(await fixture.database.select().from(agentApiKeys)).toHaveLength(0);
		await expect(
			run(
				exchangeAgentAuthorizationCode(
					{ code, codeVerifier: verifier, redirectUri },
					"request-id",
				),
			),
		).resolves.toMatchObject({ tokenType: "Bearer" });
	});
	it("never revokes a legacy desktop credential", async () => {
		const result = await run(
			revokeAgentAccessToken("request-id").pipe(
				Effect.provideService(Agent.AgentPrincipal, {
					id: owner.id,
					email: owner.email,
					activeOrganizationId: owner.activeOrganizationId,
					scopes: new Set<Agent.AgentScope>(["caps:read"]),
					tokenId: "legacy-token",
					tokenKind: "legacy",
					expiresAt: null,
				}),
			),
		);
		expect(result).toEqual({ revoked: false, requestId: "request-id" });
	});
});
