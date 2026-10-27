import {
	getAccountCapability,
	requireWorkspaceAccount,
	WorkspaceAccountRequiredError,
} from "@cap/database/cloudflare/access";
import { atomic } from "@cap/database/cloudflare/atomic";
import {
	organizationInvites,
	organizationMembers,
	organizations,
	type users,
	videoProcessingJobs,
	videos,
	videoViewerGrants,
} from "@cap/database/cloudflare/schema";
import {
	canSignInCloudflare,
	createCloudflareUser,
	provisionCloudflareInvitee,
} from "@cap/database/cloudflare/team";
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
import { createVideo } from "../../../../packages/web-backend/src/Videos/persistence";
import { createTestOwner } from "../helpers/cloudflare-team";

vi.mock("server-only", () => ({}));
const state = vi.hoisted(() => ({
	database: undefined as
		| Awaited<ReturnType<typeof createTestDatabase>>["database"]
		| undefined,
	user: null as typeof users.$inferSelect | null,
	upload: vi.fn(),
}));
vi.mock("@cap/database/cloudflare/application", () => ({
	db: () => {
		if (!state.database) throw new Error("Database missing");
		return state.database;
	},
}));
vi.mock("@cap/database/auth/session", () => ({
	getCurrentUser: async () => state.user,
}));
vi.mock("@cap/web-backend", () => ({
	S3Buckets: { getBucketAccess: state.upload },
}));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
vi.mock("@/lib/server", () => ({ runPromise: vi.fn() }));

import { createOrganization } from "@/components/forms/server";
import { ensureRecordingOrganization } from "@/lib/desktop-recording-organization";

let fixture: Awaited<ReturnType<typeof createTestDatabase>>;
let owner: Awaited<ReturnType<typeof createTestOwner>>;
let guest: typeof users.$inferSelect;
let videoId: typeof videos.$inferInsert.id;
let grantId: string;
const capability = () =>
	atomic(fixture.database, async (snapshot) => ({
		statements: [],
		result: await getAccountCapability(snapshot, guest.id),
	}));

describe("viewer-only accounts and workspace capabilities", () => {
	beforeAll(async () => {
		fixture = await createTestDatabase();
		state.database = fixture.database;
	});
	afterAll(async () => fixture?.dispose());
	beforeEach(async () => {
		owner = await createTestOwner(fixture.database);
		videoId = nanoId() as typeof videos.$inferInsert.id;
		grantId = nanoId();
		const email = `${nanoId()}@example.com`;
		await fixture.database
			.insert(videos)
			.values({
				id: videoId,
				ownerId: owner.id,
				orgId: owner.activeOrganizationId,
				name: "Private",
				public: false,
				source: { type: "webMP4" },
			});
		await fixture.database
			.insert(videoViewerGrants)
			.values({ id: grantId, videoId, email, invitedByUserId: owner.id });
		guest = await createCloudflareUser(
			fixture.database,
			{ email: email.toUpperCase(), emailVerified: new Date() },
			{ ownerEmail: owner.email, inviteOnly: true },
		);
		state.user = guest;
		state.upload.mockReset();
	});
	it("authenticates a canonical private-share viewer without creating a workspace", async () => {
		expect(
			await canSignInCloudflare(fixture.database, guest.email.toUpperCase(), {
				ownerEmail: owner.email,
				inviteOnly: true,
			}),
		).toBe(true);
		expect(await capability()).toMatchObject({ kind: "viewer" });
		expect(guest.activeOrganizationId).toBe("");
		expect(guest.defaultOrgId).toBeNull();
		expect(
			await fixture.database
				.select()
				.from(organizationMembers)
				.where(eq(organizationMembers.userId, guest.id)),
		).toHaveLength(0);
	});
	it("denies organization creation and both recording creation paths", async () => {
		const form = new FormData();
		form.set("name", "Guest escalation");
		await expect(createOrganization(form)).rejects.toBeInstanceOf(
			WorkspaceAccountRequiredError,
		);
		await expect(
			ensureRecordingOrganization(
				fixture.database,
				guest.id,
				nanoId() as typeof organizations.$inferInsert.id,
				nanoId(),
			),
		).rejects.toBeInstanceOf(WorkspaceAccountRequiredError);
		await expect(
			createVideo(fixture.database, {
				id: nanoId() as typeof videos.$inferInsert.id,
				ownerId: guest.id,
				orgId: owner.activeOrganizationId,
				name: "Denied",
				source: { type: "webMP4" },
			}),
		).rejects.toThrow(/membership/);
		expect(
			await fixture.database
				.select()
				.from(organizations)
				.where(eq(organizations.ownerId, guest.id)),
		).toHaveLength(0);
		expect(
			await fixture.database
				.select()
				.from(videos)
				.where(eq(videos.ownerId, guest.id)),
		).toHaveLength(0);
		expect(state.upload).not.toHaveBeenCalled();
	});
	it("rejects revoked grants and grants to tombstoned or deleting resources", async () => {
		await fixture.database
			.update(videoViewerGrants)
			.set({ revokedAt: new Date() })
			.where(eq(videoViewerGrants.id, grantId));
		expect(
			await canSignInCloudflare(fixture.database, guest.email, {
				ownerEmail: owner.email,
				inviteOnly: true,
			}),
		).toBe(false);
		await fixture.database
			.update(videoViewerGrants)
			.set({ revokedAt: null })
			.where(eq(videoViewerGrants.id, grantId));
		await fixture.database
			.update(organizations)
			.set({ tombstoneAt: new Date() })
			.where(eq(organizations.id, owner.activeOrganizationId));
		expect((await capability()).kind).toBe("none");
		await fixture.database
			.update(organizations)
			.set({ tombstoneAt: null })
			.where(eq(organizations.id, owner.activeOrganizationId));
		await fixture.database
			.insert(videoProcessingJobs)
			.values({
				videoId,
				ownerId: owner.id,
				generation: "deleting",
				state: "source-blocked",
				errorCode: "video-deleting",
				nextRetryAt: new Date(),
			});
		expect((await capability()).kind).toBe("none");
	});
	it("preserves explicit roster provisioning once the identity is verified", async () => {
		await provisionCloudflareInvitee(fixture.database, {
			organizationId: owner.activeOrganizationId,
			email: guest.email,
			invitedByUserId: owner.id,
			role: "member",
		});
		expect((await capability()).kind).toBe("workspace");
		await expect(
			atomic(fixture.database, async (snapshot) => ({
				statements: [],
				result: await requireWorkspaceAccount(snapshot, guest.id),
			})),
		).resolves.toMatchObject({ id: guest.id });
	});
	it("does not bootstrap an unverified provisioned account through an expired invitation", async () => {
		const email = `${nanoId()}@example.com`;
		const provisioned = await provisionCloudflareInvitee(fixture.database, {
			organizationId: owner.activeOrganizationId,
			email,
			invitedByUserId: owner.id,
			role: "member",
		});
		if (!provisioned.inviteId) throw new Error("Invitation missing");
		await fixture.database
			.update(organizationInvites)
			.set({ expiresAt: new Date(0) })
			.where(eq(organizationInvites.id, provisioned.inviteId));
		expect(
			await canSignInCloudflare(fixture.database, email, {
				ownerEmail: owner.email,
				inviteOnly: true,
			}),
		).toBe(false);
	});
});
