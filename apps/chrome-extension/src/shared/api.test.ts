import { beforeEach, expect, it, vi } from "vitest";
import {
	createAuthStart,
	createInstantRecording,
	fetchBootstrap,
	parseAuthResponse,
	revokeAuth,
} from "./api";
import { defaultSettings } from "./storage";

const origin = "https://videos.trulyauthenticmarketing.com";
const settings = { ...defaultSettings, apiBaseUrl: origin };
const auth = {
	authApiKey: "synthetic-test-key",
	userId: "synthetic-user",
	apiOrigin: origin,
};

beforeEach(() => {
	vi.unstubAllGlobals();
});

it("opens self-hosted consent with state and the installed Chrome identity callback", async () => {
	vi.stubGlobal("chrome", {
		identity: {
			getRedirectURL: () =>
				"https://ffocnmodhfclminiaapbfapkehcppkga.chromiumapp.org/",
		},
	});
	const fetcher = vi.fn(
		async (_input: RequestInfo | URL, _init?: RequestInit) =>
			new Response("", { status: 200 }),
	);
	vi.stubGlobal("fetch", fetcher);
	const result = await createAuthStart(settings);
	const target = new URL(result.url);
	expect(target.origin).toBe(origin);
	expect(target.pathname).toBe("/api/extension/auth/start");
	expect(target.searchParams.get("state")).toBe(result.state);
	expect(target.searchParams.get("redirectUri")).toBe(result.redirectUri);
	expect(fetcher.mock.calls[0]?.[0]).toEqual(target);
	const callback = `${result.redirectUri}#${new URLSearchParams({ state: result.state, authApiKey: auth.authApiKey, userId: auth.userId })}`;
	expect(parseAuthResponse(callback, result.state, origin)).toEqual(auth);
	expect(() => parseAuthResponse(callback, "wrong-state", origin)).toThrow(
		"state",
	);
});

it("preserves bearer bootstrap, recording creation and revocation paths on the chosen instance", async () => {
	const fetcher = vi.fn(
		async (_input: RequestInfo | URL, _init?: RequestInit) =>
			Response.json({ success: true }),
	);
	vi.stubGlobal("fetch", fetcher);
	await fetchBootstrap(settings, auth);
	await createInstantRecording({
		settings,
		auth,
		input: {
			orgId: "synthetic-org",
			folderId: undefined,
			supportsUploadProgress: true,
		},
	});
	await revokeAuth(settings, auth);
	expect(
		fetcher.mock.calls.map((call) => new URL(String(call[0])).pathname),
	).toEqual([
		"/api/extension/bootstrap",
		"/api/extension/instant-recordings",
		"/api/extension/auth/revoke",
	]);
	for (const [url, init] of fetcher.mock.calls) {
		expect(new URL(String(url)).origin).toBe(origin);
		expect(init).toMatchObject({
			headers: { Authorization: `Bearer ${auth.authApiKey}` },
		});
	}
});

it("never sends an existing credential to a different instance", async () => {
	const fetcher = vi.fn();
	vi.stubGlobal("fetch", fetcher);
	await expect(
		fetchBootstrap(
			{ ...settings, apiBaseUrl: "https://tam-cap-app.ciglesia.workers.dev" },
			auth,
		),
	).rejects.toThrow("Sign in to this instance");
	expect(fetcher).not.toHaveBeenCalled();
});
