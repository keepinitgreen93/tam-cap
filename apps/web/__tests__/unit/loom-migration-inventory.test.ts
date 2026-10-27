import {
	loomMigrationImports,
	loomMigrationRequests,
	videos,
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
	operator: vi.fn(),
}));
vi.mock("server-only", () => ({}));
vi.mock("@cap/env", () => ({
	serverEnv: () => ({}),
	buildEnv: { NEXT_PUBLIC_IS_CAP: "false" },
}));
vi.mock("@cap/database/cloudflare/application", () => ({
	db: () => state.database,
}));
vi.mock("@/lib/loom-concierge", async (importOriginal) => ({
	...(await importOriginal<typeof import("@/lib/loom-concierge")>()),
	requireMigrationOperator: state.operator,
}));

import { reconcileMissingLoomMigrationImports } from "@/lib/loom-migration-inventory";

let fixture: Awaited<ReturnType<typeof createTestDatabase>>;
let owner: Awaited<ReturnType<typeof createTestOwner>>;
let requestId: string;
const input = () => ({ requestId, verified: true });
async function inventory() {
	return fixture.database
		.select()
		.from(loomMigrationImports)
		.where(eq(loomMigrationImports.requestId, requestId));
}
describe("operator inventory reconciliation on D1", () => {
	beforeAll(async () => {
		fixture = await createTestDatabase();
		state.database = fixture.database;
	});
	afterAll(async () => fixture.dispose());
	afterEach(() => vi.unstubAllEnvs());
	beforeEach(async () => {
		owner = await createTestOwner(fixture.database);
		requestId = nanoId();
		vi.stubEnv("CAP_RUNTIME", "cloudflare");
		vi.stubEnv("CAP_OWNER_EMAIL", owner.email);
		state.operator.mockReset().mockResolvedValue(owner);
		await fixture.database.insert(loomMigrationRequests).values({
			id: requestId,
			organizationId: owner.activeOrganizationId,
			activeOrganizationId: owner.activeOrganizationId,
			requestedByUserId: owner.id,
			status: "in_progress",
		});
	});
	it("requires operator access before looking at the migration", async () => {
		state.operator.mockRejectedValueOnce(new Error("Forbidden"));
		await expect(reconcileMissingLoomMigrationImports(input())).rejects.toThrow(
			"Forbidden",
		);
	});
	it("requires explicit source-list confirmation", async () => {
		await expect(
			reconcileMissingLoomMigrationImports({ requestId, verified: false }),
		).rejects.toThrow("source list first");
	});
	it.each(["missing", "completed", "inactive", "other", "active", "unbounded"])(
		"holds %s requests",
		async (state) => {
			if (state === "missing")
				await fixture.database
					.delete(loomMigrationRequests)
					.where(eq(loomMigrationRequests.id, requestId));
			else
				await fixture.database
					.update(loomMigrationRequests)
					.set({
						...(state === "completed" ? { status: "completed" as const } : {}),
						...(state === "inactive" ? { activeOrganizationId: null } : {}),
						...(state === "other"
							? {
									activeOrganizationId:
										nanoId() as typeof loomMigrationRequests.$inferInsert.activeOrganizationId,
								}
							: {}),
						...(["active", "unbounded"].includes(state)
							? {
									activeImportCount: 1,
									activeImportLeaseUntil:
										state === "active" ? new Date(Date.now() + 60_000) : null,
								}
							: {}),
					})
					.where(eq(loomMigrationRequests.id, requestId));
			await expect(
				reconcileMissingLoomMigrationImports(input()),
			).rejects.toThrow("inactive or imports");
		},
	);
	it("leaves an empty inventory and request counters unchanged", async () => {
		expect(await reconcileMissingLoomMigrationImports(input())).toEqual({
			removedCount: 0,
			hasMore: false,
		});
	});
	it("permits reconciliation after the import lease expires", async () => {
		await fixture.database
			.update(loomMigrationRequests)
			.set({ activeImportCount: 1, activeImportLeaseUntil: new Date(0) })
			.where(eq(loomMigrationRequests.id, requestId));
		expect(await reconcileMissingLoomMigrationImports(input())).toEqual({
			removedCount: 0,
			hasMore: false,
		});
	});
	it("bounds deletion at 100 while preserving live videos and completion counters", async () => {
		const liveId = nanoId() as typeof videos.$inferSelect.id;
		await fixture.database.insert(videos).values({
			id: liveId,
			ownerId: owner.id,
			orgId: owner.activeOrganizationId,
			name: "Live inventory",
			source: { type: "webMP4" },
		});
		const ids = [
			...Array.from(
				{ length: 101 },
				() => nanoId() as typeof videos.$inferSelect.id,
			),
			liveId,
		];
		for (const videoId of ids)
			await fixture.database
				.insert(loomMigrationImports)
				.values({ videoId, requestId });
		expect(await reconcileMissingLoomMigrationImports(input())).toEqual({
			removedCount: 100,
			hasMore: true,
		});
		expect(await inventory()).toHaveLength(2);
		expect(await reconcileMissingLoomMigrationImports(input())).toEqual({
			removedCount: 1,
			hasMore: false,
		});
		expect(await inventory()).toMatchObject([{ videoId: liveId }]);
		const [request] = await fixture.database
			.select()
			.from(loomMigrationRequests)
			.where(eq(loomMigrationRequests.id, requestId));
		expect(request).toMatchObject({
			status: "in_progress",
			importedVideoCount: 0,
			queuedVideoCount: 0,
			lastOperatorUserId: owner.id,
		});
	});
});
