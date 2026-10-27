import { afterEach, describe, expect, it, vi } from "vitest";

const environment = vi.hoisted(() => ({
	NEXT_PUBLIC_IS_CAP: undefined as string | undefined,
}));
vi.mock("@cap/env", () => ({ buildEnv: environment }));

import {
	addDomain,
	checkDomainStatus,
	getConfigResponse,
	getDomainResponse,
	getRequiredConfig,
	verifyDomain,
} from "@/actions/organization/domain-utils";
import { userIsPro } from "../../../../packages/utils/src/constants/plans";

afterEach(() => {
	vi.unstubAllEnvs();
	vi.unstubAllGlobals();
});
describe("self-hosted service boundaries", () => {
	it.each([undefined, "false", ""])(
		"enables Pro without Stripe for self-hosted flag %s",
		(flag) => {
			environment.NEXT_PUBLIC_IS_CAP = flag;
			expect(userIsPro(null)).toBe(true);
			expect(userIsPro({ stripeSubscriptionStatus: null })).toBe(true);
		},
	);
	it("retains Cap Cloud subscription checks", () => {
		environment.NEXT_PUBLIC_IS_CAP = "true";
		expect(userIsPro(null)).toBe(false);
		expect(userIsPro({ stripeSubscriptionStatus: "active" })).toBe(true);
	});
	it("reports the configured main hostname without calling Vercel", async () => {
		vi.stubEnv("CAP_RUNTIME", "cloudflare");
		vi.stubEnv("WEB_URL", "https://videos.example.com");
		const network = vi.fn();
		vi.stubGlobal("fetch", network);
		for (const action of [
			addDomain,
			checkDomainStatus,
			getConfigResponse,
			getDomainResponse,
			getRequiredConfig,
			verifyDomain,
		]) {
			expect(await action("videos.example.com")).toMatchObject({
				verified: true,
				operatorManaged: true,
				configuredDomain: "videos.example.com",
			});
			expect(await action("other.example.com")).toMatchObject({
				verified: false,
				error: { code: "operator_managed" },
			});
		}
		expect(network).not.toHaveBeenCalled();
	});
});
