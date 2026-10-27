import { migrateDb } from "@cap/database/migrate";
import { afterEach, describe, expect, it, vi } from "vitest";
import { register } from "../../instrumentation.node";
import { validateCloudflareRuntime } from "../../lib/cloudflare-runtime";

vi.mock("@cap/database/migrate", () => ({ migrateDb: vi.fn() }));
const databaseProbe = vi.hoisted(() => {
	const first = vi.fn(async () => ({ ok: 1 }));
	return { first, prepare: vi.fn(() => ({ first })) };
});
vi.mock("@cap/database/cloudflare/bridge", () => ({
	createD1BridgeBinding: () => databaseProbe,
}));
vi.mock("@cap/env", () => ({ serverEnv: vi.fn(), buildEnv: {} }));
vi.mock("workflow/runtime", () => ({
	getWorld: () => ({ getDeploymentId: async () => "test-release" }),
}));

afterEach(() => {
	vi.unstubAllEnvs();
	vi.useRealTimers();
});

const cloudflare = {
	CAP_RUNTIME: "cloudflare",
	DATABASE_PROVIDER: "d1",
	WORKFLOW_TARGET_WORLD: "@cap/workflow-cloudflare",
};

describe("Cloudflare runtime validation", () => {
	it("fails startup if the D1 readiness query is unsuccessful", async () => {
		for (const [key, value] of Object.entries(cloudflare))
			vi.stubEnv(key, value);
		vi.stubEnv("WORKFLOW_LOCAL_DATA_DIR", "");
		vi.stubEnv("VERCEL", "");
		databaseProbe.first.mockResolvedValueOnce({ ok: 0 });
		vi.spyOn(console, "error").mockImplementation(() => {});
		vi.spyOn(process, "exit").mockImplementation(() => {
			throw new Error("startup stopped");
		});
		await expect(register()).rejects.toThrow("startup stopped");
		expect(process.exit).toHaveBeenCalledWith(1);
	});
	it("registers without scheduling migrations or bucket policy changes", async () => {
		for (const [key, value] of Object.entries(cloudflare))
			vi.stubEnv(key, value);
		vi.stubEnv("WORKFLOW_LOCAL_DATA_DIR", "");
		vi.stubEnv("VERCEL", "");
		vi.useFakeTimers();
		await register();
		expect(vi.getTimerCount()).toBe(0);
		expect(migrateDb).not.toHaveBeenCalled();
		expect(databaseProbe.prepare).toHaveBeenCalledWith("SELECT 1 AS ok");
	});
	it("leaves existing runtimes unchanged", () => {
		expect(validateCloudflareRuntime({})).toBe(false);
	});
	it("accepts the explicit durable deployment", () => {
		expect(validateCloudflareRuntime(cloudflare)).toBe(true);
	});
	it.each([undefined, "mysql"])("rejects database provider %s", (provider) => {
		expect(() =>
			validateCloudflareRuntime({ ...cloudflare, DATABASE_PROVIDER: provider }),
		).toThrow("DATABASE_PROVIDER=d1");
	});
	it.each([undefined, "local", "vercel", "@workflow/world-local"])(
		"rejects workflow target %s",
		(target) => {
			expect(() =>
				validateCloudflareRuntime({
					...cloudflare,
					WORKFLOW_TARGET_WORLD: target,
				}),
			).toThrow("durable @cap/workflow-cloudflare adapter");
		},
	);
	it.each([{ WORKFLOW_LOCAL_DATA_DIR: "/tmp/jobs" }, { VERCEL: "1" }])(
		"rejects conflicting workflow configuration %j",
		(conflict) => {
			expect(() =>
				validateCloudflareRuntime({ ...cloudflare, ...conflict }),
			).toThrow("local or Vercel workflow state");
		},
	);
});
