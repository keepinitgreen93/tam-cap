import {
	agentApiAuthorizationCodes,
	mcpOAuthClients,
	mcpOAuthRegistrationQuotas,
	mcpOAuthTokens,
} from "@cap/database/cloudflare/schema";
import { nanoId } from "@cap/database/helpers";
import { afterAll, beforeAll, expect, it, vi } from "vitest";
import { createTestDatabase } from "../../../../packages/database/cloudflare/test-runtime";
import { createTestOwner } from "../helpers/cloudflare-team";

let fixture: Awaited<ReturnType<typeof createTestDatabase>>;
vi.mock("server-only", () => ({}));
vi.mock("@cap/database/cloudflare/application", () => ({
	db: () => fixture.database,
}));

import { cleanupExpiredAgentApiRecords } from "@/lib/agent-api-cleanup";
import { cleanupExpiredMcpRecords } from "@/lib/mcp-cleanup";

beforeAll(async () => {
	fixture = await createTestDatabase();
});
afterAll(async () => fixture.dispose());
it("bounds agent cleanup and counts rows without trigger changes", async () => {
	const user = await createTestOwner(fixture.database);
	const now = new Date();
	await fixture.database
		.insert(agentApiAuthorizationCodes)
		.values(
			Array.from({ length: 3 }, () => ({
				id: nanoId(),
				userId: user.id,
				codeHash: nanoId(),
				codeChallenge: "challenge",
				redirectUri: "http://localhost/callback",
				scopes: ["caps:read" as const],
				expiresAt: new Date(now.getTime() - 10000),
			})),
		);
	const result = await cleanupExpiredAgentApiRecords({
		now,
		batchSize: 1,
		maxBatches: 2,
	});
	expect(result.authorizationCodes).toBe(2);
	expect(
		await fixture.database.select().from(agentApiAuthorizationCodes),
	).toHaveLength(1);
});
it("retains an active MCP refresh family while deleting stale clients and quotas", async () => {
	const user = await createTestOwner(fixture.database);
	const now = new Date();
	const old = new Date(now.getTime() - 100 * 24 * 60 * 60 * 1000);
	await fixture.database.insert(mcpOAuthClients).values([
		{
			id: nanoId(),
			clientId: "active",
			clientName: "Active",
			redirectUris: ["http://localhost/callback"],
			activatedAt: old,
			createdAt: old,
		},
		{
			id: nanoId(),
			clientId: "stale",
			clientName: "Stale",
			redirectUris: ["http://localhost/callback"],
			activatedAt: old,
			createdAt: old,
		},
	]);
	await fixture.database
		.insert(mcpOAuthTokens)
		.values({
			id: nanoId(),
			userId: user.id,
			clientId: "active",
			familyId: nanoId(),
			resource: "https://example.com/mcp",
			accessHash: nanoId(),
			refreshHash: nanoId(),
			accessExpiresAt: now,
			refreshExpiresAt: new Date(now.getTime() + 3600000),
		});
	await fixture.database
		.insert(mcpOAuthRegistrationQuotas)
		.values({ windowId: "expired", expiresAt: old, registrations: 1 });
	const result = await cleanupExpiredMcpRecords(now);
	expect(result.clients).toBe(1);
	expect(result.quotas).toBe(1);
	expect(
		(await fixture.database.select().from(mcpOAuthClients)).map(
			(client) => client.clientId,
		),
	).toEqual(["active"]);
});
