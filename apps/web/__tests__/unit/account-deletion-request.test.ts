import {
	messengerConversations,
	messengerMessages,
	messengerSupportEmails,
} from "@cap/database/cloudflare/schema";
import { createCloudflareUser } from "@cap/database/cloudflare/team";
import type { Video } from "@cap/web-domain";
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

vi.mock("server-only", () => ({}));
const state = vi.hoisted(() => ({
	database: undefined as
		| Awaited<ReturnType<typeof createTestDatabase>>["database"]
		| undefined,
	sendEmail: vi.fn(),
}));
vi.mock("@cap/database/cloudflare/application", () => ({
	db: () => {
		if (!state.database) throw new Error("Test database unavailable");
		return state.database;
	},
}));
vi.mock("@cap/database/emails/config", () => ({ sendEmail: state.sendEmail }));
vi.mock("@cap/database/emails/messenger-support-email", () => ({
	MessengerSupportEmail: (props: Record<string, unknown>) => props,
}));
vi.mock("@cap/env", () => ({
	serverEnv: () => ({ WEB_URL: "https://videos.example.com" }),
}));

import {
	createAccountDeletionRequest,
	createMobileContentReport,
	hasPendingAccountDeletion,
} from "@/lib/account-deletion-request";

let fixture: Awaited<ReturnType<typeof createTestDatabase>>;
let user: Awaited<ReturnType<typeof createCloudflareUser>>;

describe("account requests on D1", () => {
	beforeAll(async () => {
		Object.assign(process.env, {
			CAP_RUNTIME: "cloudflare",
			DATABASE_PROVIDER: "d1",
			CAP_OWNER_EMAIL: "operator@example.com",
		});
		fixture = await createTestDatabase();
		state.database = fixture.database;
		user = await createCloudflareUser(
			fixture.database,
			{
				email: "requester@example.com",
				emailVerified: new Date(),
				name: "Requester",
			},
			{ ownerEmail: "requester@example.com", inviteOnly: true },
		);
	});
	afterAll(async () => fixture?.dispose());
	beforeEach(async () => {
		state.sendEmail.mockReset().mockResolvedValue({ error: null });
		await fixture.database.batch([
			fixture.database.delete(messengerSupportEmails),
			fixture.database.delete(messengerMessages),
			fixture.database.delete(messengerConversations),
		]);
	});
	it("records all request rows before notifying the configured operator", async () => {
		state.sendEmail.mockImplementation(async () => {
			expect(
				await fixture.database.select().from(messengerSupportEmails),
			).toHaveLength(1);
			expect(
				await fixture.database.select().from(messengerMessages),
			).toHaveLength(1);
			expect(
				await fixture.database.select().from(messengerConversations),
			).toHaveLength(1);
			return { error: null };
		});
		const result = await createAccountDeletionRequest({ user });
		expect(result).toMatchObject({ status: "created", notificationSent: true });
		expect(state.sendEmail).toHaveBeenCalledWith(
			expect.objectContaining({
				email: "operator@example.com",
				replyTo: user.email,
				idempotencyKey: `account-deletion-${result.id}`,
			}),
		);
		expect(state.sendEmail.mock.calls[0]?.[0]).not.toHaveProperty(
			"fromOverride",
		);
	});
	it("concurrent deletion requests share one durable record", async () => {
		const results = await Promise.all(
			Array.from({ length: 4 }, () => createAccountDeletionRequest({ user })),
		);
		expect(new Set(results.map((result) => result.id)).size).toBe(1);
		expect(
			results.filter((result) => result.status === "created"),
		).toHaveLength(1);
		expect(
			await fixture.database.select().from(messengerSupportEmails),
		).toHaveLength(1);
	});
	it("retains the durable request when email delivery fails", async () => {
		state.sendEmail.mockRejectedValue(new Error("Synthetic mail failure"));
		const result = await createAccountDeletionRequest({ user });
		expect(result.notificationSent).toBe(false);
		expect(
			await fixture.database.select().from(messengerSupportEmails),
		).toHaveLength(1);
	});
	it("finds pending requests through normalized email or user identity", async () => {
		await createAccountDeletionRequest({ user });
		expect(await hasPendingAccountDeletion({ userId: user.id })).toBe(true);
		expect(
			await hasPendingAccountDeletion({ email: user.email.toUpperCase() }),
		).toBe(true);
		expect(
			await hasPendingAccountDeletion({ email: "someone@example.com" }),
		).toBe(false);
	});
	it("stores content reports and uses the private application's URL", async () => {
		const result = await createMobileContentReport({
			reporter: user,
			content: {
				id: "reported-video" as Video.VideoId,
				ownerId: user.id,
				title: "Example",
			},
			reason: "other",
		});
		expect(result.notificationSent).toBe(true);
		const [request] = await fixture.database
			.select()
			.from(messengerSupportEmails);
		expect(request?.message).toContain(
			"https://videos.example.com/s/reported-video",
		);
		expect(request?.message).not.toContain("https://cap.so/");
		expect(state.sendEmail).toHaveBeenCalledWith(
			expect.objectContaining({ email: "operator@example.com" }),
		);
	});
});
