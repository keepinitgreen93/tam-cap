import { NextRequest } from "next/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({
	user: vi.fn(),
	workspace: vi.fn(),
	convert: vi.fn(),
	fetch: vi.fn(),
	Denied: class WorkspaceAccountRequiredError extends Error {},
}));
vi.mock("@cap/database/auth/session", () => ({ getCurrentUser: state.user }));
vi.mock("@cap/database/cloudflare/access", () => ({
	requireWorkspaceAccount: state.workspace,
	WorkspaceAccountRequiredError: state.Denied,
}));
vi.mock("@cap/database/cloudflare/application", () => ({ db: () => ({}) }));
vi.mock("@cap/database/cloudflare/atomic", () => ({
	atomic: async (
		_database: unknown,
		plan: (snapshot: unknown) => Promise<unknown>,
	) => plan({}),
}));
vi.mock("@/lib/media-client", () => ({
	isMediaServerConfigured: () => true,
	fetchConvertedVideoViaMediaServer: state.convert,
}));
vi.mock("@/lib/video-convert", () => ({
	convertRemoteVideoToMp4Buffer: () => {
		throw new Error("Unexpected local conversion");
	},
}));

const request = () =>
	new NextRequest(
		"https://cap.example/api/tools/loom-download?id=abcdef12345678",
		{
			headers: { "sec-fetch-site": "same-origin" },
		},
	);

describe("Cloudflare Loom downloader compute authorization", () => {
	beforeEach(() => {
		vi.stubEnv("CAP_RUNTIME", "cloudflare");
		state.user.mockReset().mockResolvedValue(null);
		state.workspace.mockReset().mockResolvedValue({ id: "member" });
		state.convert.mockReset();
		state.fetch
			.mockReset()
			.mockImplementation(async () =>
				Response.json({ url: "https://cdn.loom.com/video.mp4" }),
			);
		vi.stubGlobal("fetch", state.fetch);
	});
	afterEach(() => {
		vi.unstubAllEnvs();
		vi.unstubAllGlobals();
	});

	it("denies anonymous requests before any Loom or media call", async () => {
		const { GET } = await import("@/app/api/tools/loom-download/route");
		expect((await GET(request())).status).toBe(401);
		expect(state.fetch).not.toHaveBeenCalled();
		expect(state.convert).not.toHaveBeenCalled();
	});

	it("denies viewer-only sessions before any Loom or media call", async () => {
		state.user.mockResolvedValue({ id: "viewer" });
		state.workspace.mockRejectedValue(new state.Denied());
		const { GET } = await import("@/app/api/tools/loom-download/route");
		expect((await GET(request())).status).toBe(403);
		expect(state.fetch).not.toHaveBeenCalled();
		expect(state.convert).not.toHaveBeenCalled();
	});

	it("retains a direct download for an authenticated workspace member", async () => {
		state.user.mockResolvedValue({ id: "member" });
		const { GET } = await import("@/app/api/tools/loom-download/route");
		const response = await GET(request());
		expect(response.status).toBe(307);
		expect(response.headers.get("location")).toBe(
			"https://cdn.loom.com/video.mp4",
		);
		expect(state.workspace).toHaveBeenCalledWith({}, "member");
	});

	it("blocks a forced cross-site GET even with a creator session", async () => {
		state.user.mockResolvedValue({ id: "member" });
		const incoming = request();
		incoming.headers.set("sec-fetch-site", "cross-site");
		const { GET } = await import("@/app/api/tools/loom-download/route");
		expect((await GET(incoming)).status).toBe(401);
		expect(state.fetch).not.toHaveBeenCalled();
	});

	it("retains the hosted public marketing download behavior", async () => {
		vi.stubEnv("CAP_RUNTIME", "");
		const { GET } = await import("@/app/api/tools/loom-download/route");
		expect((await GET(request())).status).toBe(307);
		expect(state.user).not.toHaveBeenCalled();
	});

	it("retains authenticated streaming conversion through the media server", async () => {
		state.user.mockResolvedValue({ id: "member" });
		state.fetch.mockImplementation(async (value: string, init?: RequestInit) =>
			value.startsWith("https://www.loom.com/")
				? Response.json({ url: "https://cdn.loom.com/video.m3u8" })
				: new Response(null, { status: init?.method === "HEAD" ? 404 : 500 }),
		);
		state.convert.mockResolvedValue(
			new Response("synthetic mp4", { status: 200 }),
		);
		const { GET } = await import("@/app/api/tools/loom-download/route");
		const response = await GET(request());
		expect(response.status).toBe(200);
		await expect(response.text()).resolves.toBe("synthetic mp4");
		expect(state.convert).toHaveBeenCalledExactlyOnceWith(
			"https://cdn.loom.com/video.m3u8",
			".m3u8",
		);
	});
});
