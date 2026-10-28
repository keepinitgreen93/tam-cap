import { afterEach, expect, it, vi } from "vitest";

const auth = vi.hoisted(() => vi.fn(async () => null));
const database = vi.hoisted(() => vi.fn());
const device = vi.hoisted(() => ({
	start: vi.fn(),
	poll: vi.fn(),
	limit: vi.fn(async () => undefined),
}));
vi.mock("server-only", () => ({}));
vi.mock("@cap/database/auth/session", () => ({ getCurrentUser: auth }));
vi.mock("@cap/database/auth/auth-options", () => ({
	decodeSessionToken: vi.fn(),
}));
vi.mock("@cap/database/cloudflare/application", () => ({ db: database }));
vi.mock("@cap/database/cloudflare/desktop-sign-in", async (importOriginal) => ({
	...(await importOriginal<
		typeof import("@cap/database/cloudflare/desktop-sign-in")
	>()),
	startDesktopSignIn: device.start,
	pollDesktopSignIn: device.poll,
	limitDesktopSignIn: device.limit,
}));
vi.mock("@cap/env", () => ({
	serverEnv: () => ({
		WEB_URL: "https://videos.example.com",
		NEXTAUTH_SECRET: "synthetic-test-secret",
	}),
}));

import { DesktopSignInError } from "@cap/database/cloudflare/desktop-sign-in";
import { app } from "@/app/api/desktop/[...route]/session";

afterEach(() => {
	vi.unstubAllEnvs();
	vi.clearAllMocks();
});

it("replaces Cloudflare legacy credential redirects with a domain-only update page", async () => {
	vi.stubEnv("CAP_RUNTIME", "cloudflare");
	for (const type of ["session", "api_key"]) {
		const response = await app.request(
			`/request?platform=web&type=${type}&port=8999`,
		);
		expect(response.status).toBe(426);
		expect(await response.text()).toContain("Update Cap to sign in securely");
		expect(response.headers.get("location")).toBeNull();
	}
	expect(auth).not.toHaveBeenCalled();
	expect(database).not.toHaveBeenCalled();
});

it("does not mint credentials for legacy desktop deep links on Cloudflare", async () => {
	vi.stubEnv("CAP_RUNTIME", "cloudflare");
	for (const query of ["platform=web&port=8999", "platform=desktop"]) {
		const response = await app.request(`/request?type=api_key&${query}`);
		expect(response.status).toBe(426);
		expect(response.headers.get("location")).toBeNull();
	}
	expect(auth).not.toHaveBeenCalled();
	expect(database).not.toHaveBeenCalled();
});

it("rejects browser calls to credential polling before database access", async () => {
	vi.stubEnv("CAP_RUNTIME", "cloudflare");
	const response = await app.request("/device/poll", {
		method: "POST",
		headers: {
			origin: "https://videos.example.com",
			"content-type": "application/json",
		},
		body: JSON.stringify({
			requestId: "a".repeat(64),
			verifier: "b".repeat(43),
		}),
	});
	expect(response.status).toBe(403);
	expect(database).not.toHaveBeenCalled();
});

it("bounds device JSON bodies before validation or database access", async () => {
	vi.stubEnv("CAP_RUNTIME", "cloudflare");
	for (const path of ["start", "poll"]) {
		const response = await app.request(`/device/${path}`, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ oversized: "x".repeat(4096) }),
		});
		expect(response.status).toBe(413);
		expect(await response.json()).toEqual({ error: "request_too_large" });
		expect(response.headers.get("cache-control")).toBe("no-store");
	}
	expect(database).not.toHaveBeenCalled();
});

it("maps wrong proof and slow polling to safe JSON responses with no redirects", async () => {
	vi.stubEnv("CAP_RUNTIME", "cloudflare");
	for (const [error, status] of [
		["invalid_request", 400],
		["slow_down", 429],
	] as const) {
		device.poll.mockRejectedValueOnce(new DesktopSignInError(error));
		const response = await app.request("/device/poll", {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({
				requestId: "a".repeat(64),
				verifier: "b".repeat(43),
			}),
		});
		expect(response.status).toBe(status);
		expect(await response.json()).toEqual({ error });
		expect(response.headers.get("cache-control")).toBe("no-store");
		expect(response.headers.get("location")).toBeNull();
	}
});

it("retains the legacy no-port request behavior outside Cloudflare", async () => {
	vi.stubEnv("CAP_RUNTIME", "legacy");
	const response = await app.request("/request?platform=web&type=api_key");
	expect(response.status).toBe(302);
	expect(auth).toHaveBeenCalledTimes(1);
});
