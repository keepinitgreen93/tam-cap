import { users } from "@cap/database/cloudflare/schema";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { createTestDatabase } from "../../../../packages/database/cloudflare/test-runtime.ts";
import { addTestSeat, createTestTeam } from "../helpers/cloudflare-team";

const state = vi.hoisted(() => ({
	database: undefined as
		| Awaited<ReturnType<typeof createTestDatabase>>["database"]
		| undefined,
	user: null as Awaited<ReturnType<typeof createTestTeam>>["user"] | null,
}));
vi.mock("@cap/database/cloudflare/application", () => ({
	db: () => {
		if (!state.database) throw new Error("Test database unavailable");
		return state.database;
	},
}));
vi.mock("@cap/database/auth/session", () => ({
	getCurrentUser: async () => state.user,
}));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));

import { removeOrganizationMember } from "@/actions/organization/remove-member";

let fixture: Awaited<ReturnType<typeof createTestDatabase>>;
const sponsor = async (userId: typeof users.$inferSelect.id) => {
	const [user] = await fixture.database
		.select()
		.from(users)
		.where(eq(users.id, userId));
	return user?.thirdPartyStripeSubscriptionId;
};

describe("organization member removal on D1", () => {
	beforeAll(async () => {
		fixture = await createTestDatabase();
		state.database = fixture.database;
	});
	afterAll(async () => fixture?.dispose());
	it.each([
		{ remaining: [] as (string | null)[], expected: null },
		{ remaining: ["sub_other"], expected: "sub_other" },
		{ remaining: [null], expected: "sub_original" },
		{ remaining: [null, "sub_other"], expected: "sub_other" },
	])(
		"preserves the correct remaining sponsor for $remaining",
		async ({ remaining, expected }) => {
			const team = await createTestTeam(fixture.database);
			for (const subscription of remaining)
				await addTestSeat(fixture.database, team.user, subscription);
			state.user = team.owner;
			await removeOrganizationMember(
				team.invite.memberId,
				team.owner.activeOrganizationId,
			);
			expect(await sponsor(team.user.id)).toBe(expected);
		},
	);
	it("rejects a member attempting to remove another member", async () => {
		const team = await createTestTeam(fixture.database);
		state.user = team.user;
		await expect(
			removeOrganizationMember(
				team.invite.memberId,
				team.owner.activeOrganizationId,
			),
		).rejects.toThrow(/admins|owners|permission/);
		expect(await sponsor(team.user.id)).toBe("sub_original");
	});
});
