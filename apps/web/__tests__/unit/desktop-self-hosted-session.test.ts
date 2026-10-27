import { afterEach, expect, it, vi } from "vitest";

const auth = vi.hoisted(() => vi.fn(async () => null));
const database = vi.hoisted(() => vi.fn());
vi.mock("server-only", () => ({}));
vi.mock("@cap/database/auth/session", () => ({ getCurrentUser: auth }));
vi.mock("@cap/database/auth/auth-options", () => ({
	decodeSessionToken: vi.fn(),
}));
vi.mock("@cap/database/cloudflare/application", () => ({ db: database }));
vi.mock("@cap/env", () => ({
	serverEnv: () => ({
		WEB_URL: "https://videos.example.com",
		NEXTAUTH_SECRET: "synthetic-test-secret",
	}),
}));

import { app } from "@/app/api/desktop/[...route]/session";

afterEach(() => {
	vi.unstubAllEnvs();
	vi.clearAllMocks();
});

it("rejects Cloudflare loopback sessions without a port before accessing auth or minting keys", async () => {
	vi.stubEnv("CAP_RUNTIME", "cloudflare");
	for (const type of ["session", "api_key"]) {
		const response = await app.request(`/request?platform=web&type=${type}`);
		expect(response.status).toBe(400);
		expect(await response.json()).toEqual({ error: "loopback_port_required" });
		expect(response.headers.get("location")).toBeNull();
	}
	expect(auth).not.toHaveBeenCalled();
	expect(database).not.toHaveBeenCalled();
});

it("preserves loopback sign-in and the explicit desktop platform contract", async () => {
	vi.stubEnv("CAP_RUNTIME", "cloudflare");
	for (const query of ["platform=web&port=8999", "platform=desktop"]) {
		const response = await app.request(`/request?type=api_key&${query}`);
		expect(response.status).toBe(302);
		expect(response.headers.get("location")).toContain(
			"https://videos.example.com/login",
		);
	}
	expect(auth).toHaveBeenCalledTimes(2);
	expect(database).not.toHaveBeenCalled();
});

it("retains the legacy no-port request behavior outside Cloudflare", async () => {
	vi.stubEnv("CAP_RUNTIME", "legacy");
	const response = await app.request("/request?platform=web&type=api_key");
	expect(response.status).toBe(302);
	expect(auth).toHaveBeenCalledTimes(1);
});
