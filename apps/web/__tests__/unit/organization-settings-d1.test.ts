import {
	messengerConversations,
	messengerMessages,
	organizationMembers,
	organizations,
	spaceMembers,
	spaces,
	users,
} from "@cap/database/cloudflare/schema";
import { nanoId } from "@cap/database/helpers";
import { Space } from "@cap/web-domain";
import { and, eq } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, expect, it, vi } from "vitest";
import { createTestDatabase } from "../../../../packages/database/cloudflare/test-runtime";
import { createTestOwner } from "../helpers/cloudflare-team";

let fixture: Awaited<ReturnType<typeof createTestDatabase>>;
let actor: typeof users.$inferSelect | null = null;
const cookie = vi.hoisted(() => ({ anonymousId: null as string | null }));
vi.mock("server-only", () => ({}));
vi.mock("@cap/database/cloudflare/application", () => ({
	db: () => fixture.database,
}));
vi.mock("@cap/database/auth/session", () => ({
	getCurrentUser: async () => actor,
}));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
vi.mock("next/headers", () => ({
	cookies: async () => ({
		get: () => (cookie.anonymousId ? { value: cookie.anonymousId } : undefined),
	}),
}));

import { updatePreferences } from "@/actions/notifications/update-preferences";
import { updateDefaultVideoVisibility } from "@/actions/organization/default-video-visibility";
import { updateOrganizationMemberRole } from "@/actions/organization/update-member-role";
import {
	addSpaceMembers,
	batchRemoveSpaceMembers,
	setSpaceMembers,
} from "@/app/(org)/dashboard/spaces/[spaceId]/actions";
import { isInstanceAdmin } from "@/lib/instance-admin";
import {
	getMessengerConversationForViewer,
	linkAnonymousConversationsToUser,
} from "@/lib/messenger/data";

beforeAll(async () => {
	fixture = await createTestDatabase();
}, 120000);
afterAll(async () => fixture.dispose());
beforeEach(() => {
	actor = null;
	cookie.anonymousId = null;
	vi.unstubAllEnvs();
});

async function team() {
	const owner = await createTestOwner(fixture.database);
	const member = await createTestOwner(fixture.database);
	const memberId = nanoId();
	await fixture.database.insert(organizationMembers).values({
		id: memberId,
		organizationId: owner.activeOrganizationId,
		userId: member.id,
		role: "member",
	});
	const spaceId = Space.SpaceId.make(nanoId());
	await fixture.database.insert(spaces).values({
		id: spaceId,
		name: "Team",
		organizationId: owner.activeOrganizationId,
		createdById: owner.id,
	});
	actor = owner;
	return { owner, member, memberId, spaceId };
}

it("inserts a bounded JSON roster and preserves creator admin through concurrent additions", async () => {
	const value = await team();
	await Promise.all([
		addSpaceMembers({
			spaceId: value.spaceId,
			userIds: [value.member.id],
			role: "member",
		}),
		addSpaceMembers({
			spaceId: value.spaceId,
			userIds: [value.member.id],
			role: "member",
		}),
	]);
	const result = await setSpaceMembers({
		spaceId: value.spaceId,
		userIds: [value.member.id],
		role: "member",
	});
	expect(result.count).toBe(2);
	const roster = await fixture.database
		.select()
		.from(spaceMembers)
		.where(eq(spaceMembers.spaceId, value.spaceId));
	expect(roster).toHaveLength(2);
	expect(roster.find((row) => row.userId === value.owner.id)?.role).toBe(
		"admin",
	);
	expect(roster.every((row) => row.createdAt instanceof Date)).toBe(true);
});

it("rejects outsiders without partially replacing an existing space roster", async () => {
	const value = await team();
	await setSpaceMembers({
		spaceId: value.spaceId,
		userIds: [value.member.id],
		role: "member",
	});
	const outsider = await createTestOwner(fixture.database);
	await expect(
		setSpaceMembers({
			spaceId: value.spaceId,
			userIds: [outsider.id],
			role: "member",
		}),
	).rejects.toThrow("must belong");
	expect(
		await fixture.database
			.select()
			.from(spaceMembers)
			.where(eq(spaceMembers.spaceId, value.spaceId)),
	).toHaveLength(2);
});

it("denies stale space creators after their organization membership is removed", async () => {
	const value = await team();
	await fixture.database
		.update(spaces)
		.set({ createdById: value.member.id })
		.where(eq(spaces.id, value.spaceId));
	await fixture.database
		.delete(organizationMembers)
		.where(eq(organizationMembers.id, value.memberId));
	actor = value.member;
	await expect(
		addSpaceMembers({
			spaceId: value.spaceId,
			userIds: [value.member.id],
			role: "admin",
		}),
	).rejects.toThrow("membership is required");
	actor = value.owner;
	expect(
		await setSpaceMembers({
			spaceId: value.spaceId,
			userIds: [value.owner.id],
			role: "admin",
		}),
	).toMatchObject({ success: true, count: 1 });
	const roster = await fixture.database
		.select()
		.from(spaceMembers)
		.where(eq(spaceMembers.spaceId, value.spaceId));
	expect(roster.map((member) => member.userId)).toEqual([value.owner.id]);
});

it("refuses a batch containing the space creator without removing other members", async () => {
	const value = await team();
	await setSpaceMembers({
		spaceId: value.spaceId,
		userIds: [value.member.id],
		role: "member",
	});
	const roster = await fixture.database
		.select()
		.from(spaceMembers)
		.where(eq(spaceMembers.spaceId, value.spaceId));
	await expect(
		batchRemoveSpaceMembers({ memberIds: roster.map((row) => row.id) }),
	).rejects.toThrow("permission");
	expect(
		await fixture.database
			.select()
			.from(spaceMembers)
			.where(eq(spaceMembers.spaceId, value.spaceId)),
	).toHaveLength(2);
});

it("enforces role hierarchy and manager access on live organization settings", async () => {
	const value = await team();
	await updateOrganizationMemberRole(
		value.memberId,
		value.owner.activeOrganizationId,
		"admin",
	);
	actor = {
		...value.member,
		activeOrganizationId: value.owner.activeOrganizationId,
	};
	await expect(
		updateOrganizationMemberRole(
			value.memberId,
			value.owner.activeOrganizationId,
			"member",
		),
	).rejects.toThrow("permission");
	await updateDefaultVideoVisibility(true);
	await fixture.database
		.update(organizationMembers)
		.set({ role: "member" })
		.where(eq(organizationMembers.id, value.memberId));
	await expect(updateDefaultVideoVisibility(false)).rejects.toThrow(
		"Only organization owners",
	);
	const [organization] = await fixture.database
		.select()
		.from(organizations)
		.where(eq(organizations.id, value.owner.activeOrganizationId));
	expect(organization?.defaultVideoVisibility).toBe("private");
});

it("updates only notifications and leaves unrelated user preferences intact", async () => {
	const value = await team();
	await fixture.database
		.update(users)
		.set({
			preferences: {
				notifications: {
					pauseComments: true,
					pauseReplies: false,
					pauseViews: false,
					pauseReactions: false,
				},
				trackedEvents: { user_signed_up: true },
			},
		})
		.where(eq(users.id, value.owner.id));
	await updatePreferences({
		notifications: {
			pauseComments: false,
			pauseReplies: true,
			pauseViews: false,
			pauseReactions: false,
		},
	});
	const [user] = await fixture.database
		.select()
		.from(users)
		.where(eq(users.id, value.owner.id));
	expect(user?.preferences?.notifications).toMatchObject({
		pauseComments: false,
		pauseReplies: true,
	});
	expect(user?.preferences?.trackedEvents).toEqual({ user_signed_up: true });
});

it("adopts conversations and messages together and denies a visitor after adoption", async () => {
	const value = await team();
	const other = await createTestOwner(fixture.database);
	const conversationId = nanoId();
	const anonymousId = nanoId();
	await fixture.database
		.insert(messengerConversations)
		.values({ id: conversationId, agent: "Millie", anonymousId });
	await fixture.database.insert(messengerMessages).values({
		id: nanoId(),
		conversationId,
		anonymousId,
		role: "user",
		content: "Question",
	});
	await Promise.all([
		linkAnonymousConversationsToUser({ userId: value.owner.id, anonymousId }),
		linkAnonymousConversationsToUser({ userId: other.id, anonymousId }),
	]);
	const [conversation] = await fixture.database
		.select()
		.from(messengerConversations)
		.where(eq(messengerConversations.id, conversationId));
	const [message] = await fixture.database
		.select()
		.from(messengerMessages)
		.where(eq(messengerMessages.conversationId, conversationId));
	expect([value.owner.id, other.id]).toContain(conversation?.userId);
	expect(message?.userId).toBe(conversation?.userId);
	actor = null;
	cookie.anonymousId = anonymousId;
	expect(
		await getMessengerConversationForViewer({ conversationId }),
	).toBeNull();
	const mismatches = await fixture.database
		.select()
		.from(messengerMessages)
		.where(
			and(
				eq(messengerMessages.conversationId, conversationId),
				eq(messengerMessages.userId, conversation?.userId ?? other.id),
			),
		);
	expect(mismatches).toHaveLength(1);
});

it("requires a verified configured instance owner for Cloudflare administration", () => {
	vi.stubEnv("CAP_RUNTIME", "cloudflare");
	vi.stubEnv("CAP_OWNER_EMAIL", " OWNER@example.com ");
	expect(
		isInstanceAdmin({ email: "owner@example.com", emailVerified: new Date() }),
	).toBe(true);
	expect(
		isInstanceAdmin({ email: "owner@example.com", emailVerified: null }),
	).toBe(false);
	expect(
		isInstanceAdmin({ email: "richie@cap.so", emailVerified: new Date() }),
	).toBe(false);
	vi.stubEnv("CAP_OWNER_EMAIL", "");
	expect(
		isInstanceAdmin({ email: "owner@example.com", emailVerified: new Date() }),
	).toBe(false);
});
