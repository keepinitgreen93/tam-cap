import { createCloudflareDb } from "@cap/database/cloudflare";
import {
	createD1BridgeBinding,
	handleD1BridgeRequest,
} from "@cap/database/cloudflare/bridge";
import {
	loomMigrationImports,
	loomMigrationRequests,
	users,
} from "@cap/database/cloudflare/schema";
import { nanoId } from "@cap/database/helpers";
import { eq } from "drizzle-orm";
import {
	afterAll,
	afterEach,
	beforeAll,
	beforeEach,
	describe,
	expect,
	it,
	vi,
} from "vitest";
import { createTestDatabase } from "../../../../packages/database/cloudflare/test-runtime.ts";
import { createTestOwner } from "../helpers/cloudflare-team";

const state = vi.hoisted(() => ({
	database: undefined as
		| Awaited<ReturnType<typeof createTestDatabase>>["database"]
		| undefined,
	user: vi.fn(),
	email: vi.fn(),
}));
vi.mock("server-only", () => ({}));
vi.mock("@cap/database/cloudflare/application", () => ({
	db: () => state.database,
}));
vi.mock("@cap/database/auth/session", () => ({ getCurrentUser: state.user }));
vi.mock("@cap/database/emails/config", () => ({ sendEmail: state.email }));
vi.mock("@cap/env", () => ({
	serverEnv: () => ({ WEB_URL: "https://synthetic.example" }),
	buildEnv: { NEXT_PUBLIC_IS_CAP: "false" },
}));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));

import {
	answerLoomMigrationQuestion,
	confirmLoomMigrationInvite,
	requestLoomMigration,
	updateLoomMigrationStatus,
} from "@/actions/loom-concierge";
import {
	releaseConciergeImport,
	renewConciergeImport,
	requireMigrationOperator,
	reserveConciergeImport,
} from "@/lib/loom-concierge";

let fixture: Awaited<ReturnType<typeof createTestDatabase>>;
let owner: Awaited<ReturnType<typeof createTestOwner>>;
async function createRequest() {
	const result = await requestLoomMigration({
		organizationId: owner.activeOrganizationId,
		workspaceName: "Fixture workspace",
		note: "",
	});
	if (!result.ok) throw new Error(result.error);
	return result.value.id;
}
async function currentRequest(id: string) {
	const [request] = await fixture.database
		.select()
		.from(loomMigrationRequests)
		.where(eq(loomMigrationRequests.id, id));
	if (!request) throw new Error("Fixture missing");
	return request;
}
const status = (
	requestId: string,
	nextStatus: "needs_information" | "completed",
	message = "",
) =>
	updateLoomMigrationStatus({
		requestId,
		nextStatus,
		message,
		verified: true,
		expectedVideoCount: 0,
		importedVideoCount: 0,
	});

describe("self-hosted Loom concierge on D1", () => {
	beforeAll(async () => {
		fixture = await createTestDatabase();
		state.database = fixture.database;
	});
	afterAll(async () => fixture.dispose());
	afterEach(() => vi.unstubAllEnvs());
	beforeEach(async () => {
		state.database = fixture.database;
		owner = await createTestOwner(fixture.database);
		state.user.mockReset().mockResolvedValue(owner);
		state.email.mockReset().mockResolvedValue({});
		vi.stubEnv("CAP_RUNTIME", "cloudflare");
		vi.stubEnv("CAP_OWNER_EMAIL", owner.email);
	});
	it("creates one active request under concurrent calls and routes the notice to the configured owner", async () => {
		const results = await Promise.all(Array.from({ length: 5 }, createRequest));
		expect(new Set(results).size).toBe(1);
		expect(state.email).toHaveBeenCalledTimes(1);
		expect(state.email.mock.calls[0]?.[0].email).toBe(owner.email);
	});
	it("uses the verified instance owner for operator access", async () => {
		expect((await requireMigrationOperator()).id).toBe(owner.id);
		state.user.mockResolvedValue({ ...owner, emailVerified: null });
		await expect(requireMigrationOperator()).rejects.toThrow("Unauthorized");
		state.user.mockResolvedValue(await createTestOwner(fixture.database));
		await expect(requireMigrationOperator()).rejects.toThrow("Unauthorized");
	});
	it("claims only one concurrent import lease and rejects an unverified operator at commit time", async () => {
		const id = await createRequest();
		const claims = await Promise.allSettled(
			Array.from({ length: 5 }, () => reserveConciergeImport(id, owner.id)),
		);
		expect(claims.filter((claim) => claim.status === "fulfilled")).toHaveLength(
			1,
		);
		const first = claims.find((claim) => claim.status === "fulfilled");
		if (!first || first.status !== "fulfilled")
			throw new Error("Lease missing");
		await releaseConciergeImport(id, first.value);
		await fixture.database
			.update(users)
			.set({ emailVerified: null })
			.where(eq(users.id, owner.id));
		await expect(reserveConciergeImport(id, owner.id)).rejects.toThrow(
			"Unauthorized",
		);
	});
	it("renews the exact lease and never releases a replacement lease", async () => {
		const id = await createRequest();
		const token = await reserveConciergeImport(id, owner.id);
		const previous = (await currentRequest(id)).activeImportLeaseUntil;
		await renewConciergeImport(id, token);
		expect(
			(await currentRequest(id)).activeImportLeaseUntil?.getTime(),
		).toBeGreaterThan(previous?.getTime() ?? 0);
		await releaseConciergeImport(id, "wrong-token");
		expect((await currentRequest(id)).activeImportLeaseToken).toBe(token);
		await releaseConciergeImport(id, token);
		expect((await currentRequest(id)).activeImportCount).toBe(0);
	});
	it("round-trips an information request and confirmation through current organization permissions", async () => {
		const id = await createRequest();
		expect(
			await status(id, "needs_information", "Please confirm the source list"),
		).toEqual({ ok: true, value: undefined });
		expect(
			await answerLoomMigrationQuestion({ requestId: id, answer: "Confirmed" }),
		).toEqual({ ok: true, value: undefined });
		expect((await currentRequest(id)).status).toBe("pending");
		expect(await confirmLoomMigrationInvite(id)).toEqual({
			ok: true,
			value: undefined,
		});
		expect((await currentRequest(id)).invitedAt).toBeInstanceOf(Date);
	});
	it("prevents completion while imports hold a live lease", async () => {
		const id = await createRequest();
		const token = await reserveConciergeImport(id, owner.id);
		expect(await status(id, "completed")).toMatchObject({ ok: false });
		await releaseConciergeImport(id, token);
		expect(await status(id, "completed")).toEqual({
			ok: true,
			value: undefined,
		});
		expect((await currentRequest(id)).activeOrganizationId).toBeNull();
	});
	it("retries inventory validation when an import races with completion", async () => {
		const id = await createRequest();
		let injected = false;
		state.database = createCloudflareDb(
			createD1BridgeBinding({
				fetch: async (request) => {
					const body = await request.clone().text();
					if (
						!injected &&
						body.includes('update \\"loom_migration_requests\\"')
					) {
						injected = true;
						await fixture.database
							.insert(loomMigrationImports)
							.values({
								requestId: id,
								videoId:
									nanoId() as typeof loomMigrationImports.$inferInsert.videoId,
							});
					}
					return handleD1BridgeRequest(request, fixture.binding);
				},
			}),
		);
		expect(await status(id, "completed")).toMatchObject({ ok: false });
		expect(injected).toBe(true);
		expect((await currentRequest(id)).status).toBe("pending");
		expect(state.email).toHaveBeenCalledTimes(1);
	});
});
