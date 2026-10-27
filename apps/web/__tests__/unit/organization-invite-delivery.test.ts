import { organizationInvites } from "@cap/database/cloudflare/schema";
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
	user: null as Awaited<ReturnType<typeof createTestOwner>> | null,
	sendEmail: vi.fn(),
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
vi.mock("@cap/database/emails/config", () => ({ sendEmail: state.sendEmail }));
vi.mock("@cap/database/emails/organization-invite", () => ({
	OrganizationInvite: (props: unknown) => props,
}));
vi.mock("@cap/env", () => ({
	serverEnv: () => ({ WEB_URL: "https://cap.example" }),
}));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));

import { sendOrganizationInvites } from "@/actions/organization/send-invites";

let fixture: Awaited<ReturnType<typeof createTestDatabase>>;
let owner: Awaited<ReturnType<typeof createTestOwner>>;

describe("organization invite delivery on D1", () => {
	beforeAll(async () => {
		fixture = await createTestDatabase();
		state.database = fixture.database;
	});
	afterAll(async () => fixture?.dispose());
	beforeEach(async () => {
		owner = await createTestOwner(fixture.database);
		state.user = owner;
		state.sendEmail.mockReset();
	});
	it("preserves skipped records and reports them separately", async () => {
		state.sendEmail.mockResolvedValue({
			error: { name: "email_not_configured" },
		});
		const result = await sendOrganizationInvites(
			["Person@EXAMPLE.COM"],
			owner.activeOrganizationId,
		);
		expect(result).toMatchObject({
			failedEmails: [],
			skippedEmails: ["person@example.com"],
		});
		const rows = await fixture.database
			.select()
			.from(organizationInvites)
			.where(
				eq(organizationInvites.organizationId, owner.activeOrganizationId),
			);
		expect(rows.map((row) => row.invitedEmail)).toEqual(["person@example.com"]);
	});
	it("cleans up only failed deliveries in a mixed batch", async () => {
		state.sendEmail
			.mockResolvedValueOnce({ error: { name: "email_not_configured" } })
			.mockResolvedValueOnce({ error: { name: "validation_error" } })
			.mockResolvedValueOnce({ data: { id: "sent" }, error: null });
		const result = await sendOrganizationInvites(
			["skipped@example.com", "failed@example.com", "sent@example.com"],
			owner.activeOrganizationId,
		);
		expect(result).toMatchObject({
			failedEmails: ["failed@example.com"],
			skippedEmails: ["skipped@example.com"],
		});
		const rows = await fixture.database
			.select()
			.from(organizationInvites)
			.where(
				eq(organizationInvites.organizationId, owner.activeOrganizationId),
			);
		expect(rows.map((row) => row.invitedEmail).sort()).toEqual([
			"sent@example.com",
			"skipped@example.com",
		]);
	});
	it("concurrent invitations do not create duplicate canonical addresses", async () => {
		state.sendEmail.mockResolvedValue({ error: null });
		await Promise.all([
			sendOrganizationInvites(
				["person@example.com"],
				owner.activeOrganizationId,
			),
			sendOrganizationInvites(
				["PERSON@example.com"],
				owner.activeOrganizationId,
			),
		]);
		expect(
			await fixture.database
				.select()
				.from(organizationInvites)
				.where(
					eq(organizationInvites.organizationId, owner.activeOrganizationId),
				),
		).toHaveLength(1);
		expect(state.sendEmail).toHaveBeenCalledTimes(1);
	});
});
