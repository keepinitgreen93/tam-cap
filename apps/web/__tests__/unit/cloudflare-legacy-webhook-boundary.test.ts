import { afterEach, expect, it, vi } from "vitest";

const calls = vi.hoisted(() => ({
	database: vi.fn(),
	stripe: vi.fn(),
	email: vi.fn(),
}));
vi.mock("server-only", () => ({}));
vi.mock("@cap/database/legacy", () => ({ db: calls.database }));
vi.mock("@cap/database/emails/config", () => ({ sendEmail: calls.email }));
vi.mock("@cap/env", () => ({
	buildEnv: { NEXT_PUBLIC_IS_CAP: "false" },
	serverEnv: () => ({}),
}));
vi.mock("@cap/utils", async (importOriginal) => ({
	...(await importOriginal<typeof import("@cap/utils")>()),
	stripe: calls.stripe,
}));
afterEach(() => vi.unstubAllEnvs());

it("rejects hosted Stripe webhooks before reading body, credentials, database, or sending email", async () => {
	vi.stubEnv("CAP_RUNTIME", "cloudflare");
	const { POST } = await import("@/app/api/webhooks/stripe/route");
	const request = new Request("https://synthetic.example/api/webhooks/stripe", {
		method: "POST",
		body: "synthetic",
	});
	const body = vi.spyOn(request, "text");
	expect((await POST(request)).status).toBe(404);
	expect(body).not.toHaveBeenCalled();
	expect(calls.database).not.toHaveBeenCalled();
	expect(calls.stripe).not.toHaveBeenCalled();
	expect(calls.email).not.toHaveBeenCalled();
});
