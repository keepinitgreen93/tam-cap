import { organizationMembers, users } from "@cap/database/cloudflare/schema";
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
import {
	addTestSeat,
	createTestOwner,
	createTestTeam,
} from "../helpers/cloudflare-team";

const state = vi.hoisted(() => ({
	database: undefined as
		| Awaited<ReturnType<typeof createTestDatabase>>["database"]
		| undefined,
	user: vi.fn(),
}));
vi.mock("@cap/database/cloudflare/application", () => ({
	db: () => state.database,
}));
vi.mock("@cap/database/auth/session", () => ({ getCurrentUser: state.user }));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));

import { toggleProSeat } from "@/actions/organization/toggle-pro-seat";

let fixture: Awaited<ReturnType<typeof createTestDatabase>>;
let team: Awaited<ReturnType<typeof createTestTeam>>;
const toggle = (enable: boolean) =>
	toggleProSeat(team.invite.memberId, team.owner.activeOrganizationId, enable);
async function recipient() {
	const [user] = await fixture.database
		.select()
		.from(users)
		.where(eq(users.id, team.user.id));
	if (!user) throw new Error("Fixture missing");
	return user;
}
async function seat() {
	const [member] = await fixture.database
		.select()
		.from(organizationMembers)
		.where(eq(organizationMembers.id, team.invite.memberId));
	if (!member) throw new Error("Fixture missing");
	return member;
}
describe("self-hosted seat control on D1", () => {
	beforeAll(async () => {
		fixture = await createTestDatabase();
		state.database = fixture.database;
	});
	afterAll(async () => fixture.dispose());
	beforeEach(async () => {
		team = await createTestTeam(fixture.database);
		state.user.mockReset().mockResolvedValue(team.owner);
	});
	it("clears legacy subscription sponsorship when no other seat remains", async () => {
		await toggle(false);
		expect((await seat()).hasProSeat).toBe(false);
		expect((await recipient()).thirdPartyStripeSubscriptionId).toBeNull();
	});
	it("keeps legacy sponsorship when an unpaid manager-sponsored seat remains", async () => {
		await addTestSeat(fixture.database, team.user, null);
		await toggle(false);
		expect((await recipient()).thirdPartyStripeSubscriptionId).toBe(
			"sub_original",
		);
	});
	it("moves legacy sponsorship to a remaining paid seat", async () => {
		await addTestSeat(fixture.database, team.user, "sub_other");
		await toggle(false);
		expect((await recipient()).thirdPartyStripeSubscriptionId).toBe(
			"sub_other",
		);
	});
	it("prefers a remaining paid seat over an unpaid one", async () => {
		await addTestSeat(fixture.database, team.user, null);
		await addTestSeat(fixture.database, team.user, "sub_other");
		await toggle(false);
		expect((await recipient()).thirdPartyStripeSubscriptionId).toBe(
			"sub_other",
		);
	});
	it("keeps repeated removal consistent", async () => {
		await toggle(false);
		await toggle(false);
		expect((await seat()).hasProSeat).toBe(false);
		expect((await recipient()).thirdPartyStripeSubscriptionId).toBeNull();
	});
	it("permits self-hosted seat activation without a hosted billing subscription", async () => {
		await toggle(false);
		expect(await toggle(true)).toEqual({ success: true });
		expect((await seat()).hasProSeat).toBe(true);
		expect((await recipient()).thirdPartyStripeSubscriptionId).toBeNull();
	});
	it("rejects users outside the organization management roster", async () => {
		const other = await createTestOwner(fixture.database);
		state.user.mockResolvedValue(other);
		await expect(toggle(false)).rejects.toThrow();
		expect((await seat()).hasProSeat).toBe(true);
	});
	it("rejects changing the organization's owner's seat", async () => {
		const [ownerMember] = await fixture.database
			.select()
			.from(organizationMembers)
			.where(eq(organizationMembers.userId, team.owner.id));
		if (!ownerMember) throw new Error("Owner member missing");
		await expect(
			toggleProSeat(ownerMember.id, team.owner.activeOrganizationId, true),
		).rejects.toThrow("organization owner");
	});
	it("rejects a member ID from another organization", async () => {
		await expect(
			toggleProSeat(
				team.invite.memberId,
				team.user.activeOrganizationId,
				false,
			),
		).rejects.toThrow();
		expect((await seat()).hasProSeat).toBe(true);
	});
});
