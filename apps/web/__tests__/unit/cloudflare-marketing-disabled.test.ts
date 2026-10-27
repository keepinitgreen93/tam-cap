import { createCloudflareDb } from "@cap/database/cloudflare";
import { createD1BridgeBinding } from "@cap/database/cloudflare/bridge";
import { loopsSyncStatements } from "@cap/database/cloudflare/loops";
import type { User } from "@cap/web-domain";
import { afterEach, describe, expect, it, vi } from "vitest";

const calls = vi.hoisted(() => ({
	connect: vi.fn(),
	fetch: vi.fn(),
	getCurrentUser: vi.fn(),
}));
vi.mock("mysql2/promise", () => ({
	default: { createConnection: calls.connect },
}));
vi.mock("@cap/database/auth/session", () => ({
	getCurrentUser: calls.getCurrentUser,
}));

import { customerCopy } from "@cap/database/loops/customer-copy";
import { readLoopsHealth } from "@cap/database/loops/health";
import { enqueueLoopsSync } from "@cap/database/loops/queue";
import { runLoopsSync } from "@cap/database/loops/worker";
import { checkAndMarkUserSignedUpTracked } from "@/actions/analytics/track-user-signed-up";

describe("Cloudflare excludes hosted Cap marketing", () => {
	afterEach(() => {
		vi.unstubAllEnvs();
		vi.unstubAllGlobals();
		vi.clearAllMocks();
	});
	it("does not connect, enqueue, or send even when hosted marketing flags are set", async () => {
		vi.stubEnv("CAP_RUNTIME", "cloudflare");
		vi.stubEnv("LOOPS_SYNC_ENABLED", "true");
		vi.stubEnv("LOOPS_SYNC_MODE", "production");
		vi.stubEnv("LOOPS_ENROLLMENT_ENABLED", "true");
		vi.stubGlobal("fetch", calls.fetch);
		expect(await runLoopsSync(customerCopy)).toEqual({
			enabled: false,
			processed: 0,
			failed: 0,
		});
		expect(await readLoopsHealth()).toMatchObject({
			healthy: false,
			totalJobs: 0,
			overdueJobs: 0,
			failingJobs: 0,
		});
		const insert = vi.fn();
		await enqueueLoopsSync({ insert }, "owner" as User.UserId);
		const database = createCloudflareDb(
			createD1BridgeBinding({ fetch: calls.fetch }),
		);
		expect(loopsSyncStatements(database, "owner" as User.UserId)).toEqual([]);
		expect(await checkAndMarkUserSignedUpTracked()).toEqual({
			shouldTrack: false,
		});
		expect(insert).not.toHaveBeenCalled();
		expect(calls.connect).not.toHaveBeenCalled();
		expect(calls.fetch).not.toHaveBeenCalled();
		expect(calls.getCurrentUser).not.toHaveBeenCalled();
	});
});
