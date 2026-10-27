import {
	folders,
	organizationMembers,
	organizations,
	spaceMembers,
	spaces,
	spaceVideos,
} from "@cap/database/cloudflare/schema";
import { nanoId } from "@cap/database/helpers";
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

const state = vi.hoisted(() => ({
	database: undefined as
		| Awaited<ReturnType<typeof createTestDatabase>>["database"]
		| undefined,
	user: vi.fn(),
	manager: vi.fn(),
	cleanup: vi.fn(),
}));
vi.mock("@cap/database/cloudflare/application", () => ({
	db: () => state.database,
}));
vi.mock("@cap/database/auth/session", () => ({ getCurrentUser: state.user }));
vi.mock("@/actions/organization/space-authorization", () => ({
	requireSpaceManager: state.manager,
}));
vi.mock("@cap/web-backend", () => ({ S3Buckets: {} }));
vi.mock("@/lib/server", () => ({ runPromise: state.cleanup }));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));

import { deleteSpace } from "@/actions/organization/delete-space";

let fixture: Awaited<ReturnType<typeof createTestDatabase>>;
let owner: Awaited<ReturnType<typeof createTestOwner>>;
let spaceId: typeof spaces.$inferSelect.id;
async function remainingRows() {
	return Promise.all([
		fixture.database.select().from(spaces).where(eq(spaces.id, spaceId)),
		fixture.database
			.select()
			.from(spaceMembers)
			.where(eq(spaceMembers.spaceId, spaceId)),
		fixture.database
			.select()
			.from(spaceVideos)
			.where(eq(spaceVideos.spaceId, spaceId)),
		fixture.database.select().from(folders).where(eq(folders.spaceId, spaceId)),
	]);
}
describe("deleting a space on D1", () => {
	beforeAll(async () => {
		fixture = await createTestDatabase();
		state.database = fixture.database;
	});
	afterAll(async () => fixture.dispose());
	beforeEach(async () => {
		owner = await createTestOwner(fixture.database);
		spaceId = nanoId() as typeof spaces.$inferSelect.id;
		await fixture.database.insert(spaces).values({
			id: spaceId,
			organizationId: owner.activeOrganizationId,
			createdById: owner.id,
			name: "Delete fixture",
		});
		await fixture.database
			.insert(spaceMembers)
			.values({ id: nanoId(), spaceId, userId: owner.id, role: "admin" });
		await fixture.database.insert(spaceVideos).values({
			id: nanoId(),
			spaceId,
			videoId: nanoId() as typeof spaceVideos.$inferInsert.videoId,
			addedById: owner.id,
		});
		await fixture.database.insert(folders).values({
			id: nanoId() as typeof folders.$inferInsert.id,
			name: "Folder",
			organizationId: owner.activeOrganizationId,
			createdById: owner.id,
			spaceId,
		});
		state.user.mockReset().mockResolvedValue(owner);
		state.manager.mockReset().mockResolvedValue({ canManage: true });
		state.cleanup.mockReset().mockResolvedValue(undefined);
	});
	it("removes all related records atomically before storage cleanup", async () => {
		state.cleanup.mockImplementationOnce(async () => {
			expect((await remainingRows()).every((rows) => rows.length === 0)).toBe(
				true,
			);
		});
		expect(await deleteSpace(spaceId)).toEqual({ success: true });
		expect(state.cleanup).toHaveBeenCalledTimes(1);
	});
	it("leaves every record intact when the caller cannot manage the space", async () => {
		state.manager.mockRejectedValueOnce(new Error("Forbidden"));
		expect((await deleteSpace(spaceId)).success).toBe(false);
		expect((await remainingRows()).every((rows) => rows.length === 1)).toBe(
			true,
		);
		expect(state.cleanup).not.toHaveBeenCalled();
	});
	it("rechecks role changes made after the initial authorization", async () => {
		const other = await createTestOwner(fixture.database);
		state.manager.mockImplementationOnce(async () => {
			await fixture.database
				.update(organizations)
				.set({ ownerId: other.id })
				.where(eq(organizations.id, owner.activeOrganizationId));
			await fixture.database
				.update(organizationMembers)
				.set({ role: "member" })
				.where(eq(organizationMembers.userId, owner.id));
			await fixture.database
				.update(spaceMembers)
				.set({ role: "member" })
				.where(eq(spaceMembers.spaceId, spaceId));
			await fixture.database
				.update(spaces)
				.set({ createdById: other.id })
				.where(eq(spaces.id, spaceId));
			return { canManage: true };
		});
		expect((await deleteSpace(spaceId)).success).toBe(false);
		expect((await remainingRows()).every((rows) => rows.length === 1)).toBe(
			true,
		);
		expect(state.cleanup).not.toHaveBeenCalled();
	});
});
