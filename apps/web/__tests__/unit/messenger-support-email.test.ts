import type { CloudflareDatabase } from "@cap/database/cloudflare";
import {
	messengerConversations,
	messengerSupportEmails,
} from "@cap/database/cloudflare/schema";
import { nanoId } from "@cap/database/helpers";
import {
	afterAll,
	beforeAll,
	beforeEach,
	describe,
	expect,
	it,
	vi,
} from "vitest";
import { createTestDatabase } from "../../../../packages/database/cloudflare/test-runtime";
import { createTestOwner } from "../helpers/cloudflare-team";

let database: CloudflareDatabase;
let runtime: Awaited<ReturnType<typeof createTestDatabase>>;
const sendEmail = vi.hoisted(() => vi.fn());
const template = vi.hoisted(() => vi.fn(() => null));
vi.mock("server-only", () => ({}));
vi.mock("@cap/database/cloudflare/application", () => ({ db: () => database }));
vi.mock("@cap/database/emails/config", () => ({ sendEmail }));
vi.mock("@cap/database/emails/messenger-support-email", () => ({
	MessengerSupportEmail: template,
}));

beforeAll(async () => {
	runtime = await createTestDatabase();
	database = runtime.database;
});
afterAll(async () => {
	await runtime.dispose();
	vi.unstubAllEnvs();
});
beforeEach(() => {
	vi.stubEnv("CAP_OWNER_EMAIL", "owner@example.com");
	vi.stubEnv("RESEND_FROM_DOMAIN", "updates.example.com");
	sendEmail.mockResolvedValue({ data: { id: "delivered" }, error: null });
});

async function input() {
	const user = await createTestOwner(database);
	const conversationId = nanoId();
	await database
		.insert(messengerConversations)
		.values({ id: conversationId, userId: user.id, agent: "Millie" });
	return {
		user,
		conversationId,
		subject: "  Upload\nissue  ",
		message: "  Uploads keep failing.  ",
		now: new Date("2026-06-30T18:00:00.000Z"),
	};
}

describe("sendMessengerSupportEmail with D1", () => {
	it("records the reservation before sending to the configured owner and sender", async () => {
		const { sendMessengerSupportEmail } = await import(
			"@/lib/messenger/support-email"
		);
		const request = await input();
		sendEmail.mockImplementationOnce(async () => {
			const rows = await database.select().from(messengerSupportEmails);
			expect(
				rows.some(
					(row) =>
						row.userId === request.user.id && row.subject === "Upload issue",
				),
			).toBe(true);
			return { data: { id: "delivered" }, error: null };
		});
		expect(await sendMessengerSupportEmail(request)).toEqual({
			status: "sent",
			remainingToday: 1,
		});
		expect(sendEmail).toHaveBeenCalledWith(
			expect.objectContaining({
				email: "owner@example.com",
				fromOverride: "Cap Support <support@updates.example.com>",
				replyTo: request.user.email,
				subject: "Messenger support: Upload issue",
			}),
		);
		expect(template).toHaveBeenCalledWith(
			expect.objectContaining({
				userEmail: request.user.email,
				conversationId: request.conversationId,
				message: "Uploads keep failing.",
			}),
		);
	});
	it("admits only two concurrent reservations per UTC day", async () => {
		const { sendMessengerSupportEmail } = await import(
			"@/lib/messenger/support-email"
		);
		const request = await input();
		const results = await Promise.all(
			Array.from({ length: 5 }, () => sendMessengerSupportEmail(request)),
		);
		expect(results.filter((result) => result.status === "sent")).toHaveLength(
			2,
		);
		expect(
			results.filter((result) => result.status === "rate_limited"),
		).toHaveLength(3);
		expect(sendEmail).toHaveBeenCalledTimes(2);
		expect(
			(
				await sendMessengerSupportEmail({
					...request,
					now: new Date("2026-07-01T00:00:00Z"),
				})
			).status,
		).toBe("sent");
	});
	it.each([
		["email_not_configured", "Email is not configured"],
		["validation_error", "Sender domain is not verified"],
	])("does not report a returned %s as sent", async (name, message) => {
		const { sendMessengerSupportEmail } = await import(
			"@/lib/messenger/support-email"
		);
		sendEmail.mockResolvedValueOnce({ data: null, error: { name, message } });
		await expect(sendMessengerSupportEmail(await input())).rejects.toThrow(
			message,
		);
	});
	it("does not report missing provider confirmation as sent", async () => {
		const { sendMessengerSupportEmail } = await import(
			"@/lib/messenger/support-email"
		);
		sendEmail.mockResolvedValueOnce(undefined);
		await expect(sendMessengerSupportEmail(await input())).rejects.toThrow(
			"delivery was not confirmed",
		);
	});
	it("does not send when the audit reservation fails", async () => {
		const { sendMessengerSupportEmail } = await import(
			"@/lib/messenger/support-email"
		);
		const request = await input();
		await runtime.binding
			.prepare(
				"CREATE TRIGGER reject_support BEFORE INSERT ON messenger_support_emails BEGIN SELECT RAISE(ABORT, 'insert failed'); END",
			)
			.run();
		try {
			await expect(sendMessengerSupportEmail(request)).rejects.toThrow();
			expect(sendEmail).not.toHaveBeenCalled();
		} finally {
			await runtime.binding.prepare("DROP TRIGGER reject_support").run();
		}
	});
	it("fails closed when owner configuration is missing", async () => {
		const { sendMessengerSupportEmail } = await import(
			"@/lib/messenger/support-email"
		);
		vi.stubEnv("CAP_OWNER_EMAIL", "");
		await expect(sendMessengerSupportEmail(await input())).rejects.toThrow(
			"Invalid email",
		);
		expect(sendEmail).not.toHaveBeenCalled();
	});
});
