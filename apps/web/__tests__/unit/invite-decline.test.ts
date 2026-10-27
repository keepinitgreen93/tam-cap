import { organizationInvites } from "@cap/database/cloudflare/schema";
import { eq } from "drizzle-orm";
import type { NextRequest } from "next/server";
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
import { createTestTeam } from "../helpers/cloudflare-team";

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

import { POST } from "@/app/api/invite/decline/route";

let fixture: Awaited<ReturnType<typeof createTestDatabase>>;
let team: Awaited<ReturnType<typeof createTestTeam>>;
const request = (body: unknown, crossSite = false) =>
	new Request("https://cap.test/api/invite/decline", {
		method: "POST",
		headers: {
			"Content-Type": "application/json",
			...(crossSite ? { "Sec-Fetch-Site": "cross-site" } : {}),
		},
		body: JSON.stringify(body),
	}) as NextRequest;

describe("POST /api/invite/decline on D1", () => {
	beforeAll(async () => {
		fixture = await createTestDatabase();
		state.database = fixture.database;
	});
	afterAll(async () => fixture?.dispose());
	beforeEach(async () => {
		team = await createTestTeam(fixture.database);
		state.user = team.user;
	});
	it("returns 401 when the requester is not authenticated", async () => {
		state.user = null;
		expect(
			(await POST(request({ inviteId: team.invite.inviteId }))).status,
		).toBe(401);
	});
	it("rejects cross-site cookie writes", async () => {
		expect(
			(await POST(request({ inviteId: team.invite.inviteId }, true))).status,
		).toBe(401);
	});
	it("returns 400 for missing or expired invitations", async () => {
		expect((await POST(request({}))).status).toBe(400);
		await fixture.database
			.update(organizationInvites)
			.set({ expiresAt: new Date(0) })
			.where(eq(organizationInvites.id, team.invite.inviteId));
		expect(
			(await POST(request({ inviteId: team.invite.inviteId }))).status,
		).toBe(400);
	});
	it("returns 404 when the invite does not exist", async () => {
		expect((await POST(request({ inviteId: "missing-invite" }))).status).toBe(
			404,
		);
	});
	it("returns 403 when the authenticated user is not the invitee", async () => {
		state.user = team.owner;
		expect(
			(await POST(request({ inviteId: team.invite.inviteId }))).status,
		).toBe(403);
	});
	it("deletes the invite when the authenticated user is its invitee", async () => {
		expect(
			(await POST(request({ inviteId: team.invite.inviteId }))).status,
		).toBe(200);
		expect(
			await fixture.database
				.select()
				.from(organizationInvites)
				.where(eq(organizationInvites.id, team.invite.inviteId)),
		).toHaveLength(0);
	});
});
