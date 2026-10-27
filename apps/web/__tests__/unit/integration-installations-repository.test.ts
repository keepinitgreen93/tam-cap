import { readFileSync } from "node:fs";
import { join } from "node:path";
import { integrationInstallations } from "@cap/database/cloudflare/schema";
import { nanoId } from "@cap/database/helpers";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, expect, it, vi } from "vitest";
import { createTestDatabase } from "../../../../packages/database/cloudflare/test-runtime";
import { createTestOwner } from "../helpers/cloudflare-team";

let fixture: Awaited<ReturnType<typeof createTestDatabase>>;
const cryptoMocks = vi.hoisted(() => ({ decrypt: vi.fn(), encrypt: vi.fn() }));
vi.mock("@cap/database/cloudflare/application", () => ({
	db: () => fixture.database,
}));
vi.mock("@cap/database/crypto", () => cryptoMocks);

import {
	deleteIntegrationInstallation,
	deleteIntegrationInstallationByExternalId,
	getIntegrationCredentials,
	listIntegrationInstallations,
	saveIntegrationInstallation,
} from "@/lib/integrations/installations";

beforeAll(async () => {
	fixture = await createTestDatabase();
}, 120000);
afterAll(async () => fixture.dispose());
beforeEach(() => {
	vi.clearAllMocks();
	cryptoMocks.encrypt.mockImplementation(
		async (value: string) => `encrypted:${value}`,
	);
	cryptoMocks.decrypt.mockImplementation(async (value: string) =>
		value.slice("encrypted:".length),
	);
});
async function input() {
	const owner = await createTestOwner(fixture.database);
	return {
		provider: "slack",
		externalId: nanoId(),
		displayName: "Cap",
		organizationId: owner.activeOrganizationId,
		installedByUserId: owner.id,
		credentials: { accessToken: "synthetic-token" },
		metadata: { scopes: ["links:read"] },
	};
}
it("updates only its own tenant's installation while retaining the stable ID", async () => {
	const value = await input();
	await saveIntegrationInstallation(value);
	const [original] = await listIntegrationInstallations(value);
	await saveIntegrationInstallation({
		...value,
		displayName: "Renamed",
		credentials: { accessToken: "rotated-token" },
	});
	const rows = await fixture.database
		.select()
		.from(integrationInstallations)
		.where(eq(integrationInstallations.externalId, value.externalId));
	expect(rows).toHaveLength(1);
	expect(rows[0]).toMatchObject({
		id: original?.id,
		organizationId: value.organizationId,
		displayName: "Renamed",
		encryptedCredentials: 'encrypted:{"accessToken":"rotated-token"}',
	});
	expect(cryptoMocks.encrypt).toHaveBeenLastCalledWith(
		JSON.stringify({ accessToken: "rotated-token" }),
	);
});
it("allows exactly one organization to claim an external installation concurrently", async () => {
	const first = await input();
	const second = { ...(await input()), externalId: first.externalId };
	const results = await Promise.allSettled([
		saveIntegrationInstallation(first),
		saveIntegrationInstallation(second),
	]);
	expect(
		results.filter((result) => result.status === "fulfilled"),
	).toHaveLength(1);
	const rejected = results.find((result) => result.status === "rejected");
	expect(rejected?.status === "rejected" ? rejected.reason.message : null).toBe(
		"Integration is already connected to another organization",
	);
	const [winner] = await fixture.database
		.select()
		.from(integrationInstallations)
		.where(eq(integrationInstallations.externalId, first.externalId));
	expect([first.organizationId, second.organizationId]).toContain(
		winner?.organizationId,
	);
});
it("ships provider-agnostic indexes in legacy and D1 migrations", () => {
	const migration = readFileSync(
		join(
			process.cwd(),
			"../../packages/database/migrations/0037_integration_installations.sql",
		),
		"utf8",
	);
	expect(migration).toContain("CREATE TABLE `integration_installations`");
	expect(migration).toContain(
		"CONSTRAINT `provider_external_id_idx` UNIQUE(`provider`,`externalId`)",
	);
	expect(migration).toContain(
		"CREATE INDEX `organization_provider_display_name_idx` ON `integration_installations` (`organizationId`,`provider`,`displayName`)",
	);
	expect(migration).not.toContain("slack_installations");
	expect(migration).not.toContain("encryptedBotToken");
	const native = readFileSync(
		join(
			process.cwd(),
			"../../packages/database/cloudflare/migrations/0000_rare_robbie_robertson.sql",
		),
		"utf8",
	);
	expect(native).toContain("provider_external_id_idx");
	expect(native).toContain("organization_provider_display_name_idx");
});
it("lists only the non-secret tenant-scoped summary shape", async () => {
	const value = await input();
	await saveIntegrationInstallation(value);
	await saveIntegrationInstallation(await input());
	const rows = await listIntegrationInstallations(value);
	expect(rows).toHaveLength(1);
	expect(rows[0]).toMatchObject({
		externalId: value.externalId,
		displayName: "Cap",
		createdAt: expect.any(Date),
		updatedAt: expect.any(Date),
	});
	expect(Object.keys(rows[0] ?? {}).sort()).toEqual([
		"createdAt",
		"displayName",
		"externalId",
		"id",
		"updatedAt",
	]);
});
it("decrypts credentials only after exact provider and external-ID lookup", async () => {
	const value = await input();
	await saveIntegrationInstallation(value);
	expect(await getIntegrationCredentials(value)).toEqual(value.credentials);
	expect(cryptoMocks.decrypt).toHaveBeenCalledWith(
		`encrypted:${JSON.stringify(value.credentials)}`,
	);
	cryptoMocks.decrypt.mockClear();
	expect(
		await getIntegrationCredentials({ ...value, provider: "other" }),
	).toBeNull();
	expect(cryptoMocks.decrypt).not.toHaveBeenCalled();
});
it("fails closed when decrypted credentials are malformed", async () => {
	const value = await input();
	await saveIntegrationInstallation(value);
	cryptoMocks.decrypt.mockResolvedValue("not-json");
	await expect(getIntegrationCredentials(value)).rejects.toThrow();
});
it("supports tenant-scoped disconnects and provider-scoped uninstalls", async () => {
	const value = await input();
	await saveIntegrationInstallation(value);
	const [row] = await listIntegrationInstallations(value);
	if (!row) throw new Error("Missing test installation");
	const other = await input();
	await deleteIntegrationInstallation({
		...value,
		organizationId: other.organizationId,
		installationId: row.id,
	});
	expect(await listIntegrationInstallations(value)).toHaveLength(1);
	await deleteIntegrationInstallation({ ...value, installationId: row.id });
	expect(await listIntegrationInstallations(value)).toHaveLength(0);
	await saveIntegrationInstallation(value);
	await deleteIntegrationInstallationByExternalId({
		...value,
		provider: "other",
	});
	expect(await listIntegrationInstallations(value)).toHaveLength(1);
	await deleteIntegrationInstallationByExternalId(value);
	expect(await listIntegrationInstallations(value)).toHaveLength(0);
});
