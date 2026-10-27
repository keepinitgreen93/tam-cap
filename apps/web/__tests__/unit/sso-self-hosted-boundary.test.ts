import { Organisation, User } from "@cap/web-domain";
import { afterEach, expect, it, vi } from "vitest";

const database = vi.hoisted(() =>
	vi.fn(() => {
		throw new Error("Vendor database must not be used");
	}),
);
const payment = vi.hoisted(() =>
	vi.fn(() => {
		throw new Error("Stripe must not be used");
	}),
);
vi.mock("@cap/database/legacy", () => ({ db: database }));
vi.mock("@cap/utils", () => ({
	stripe: payment,
	isSsoPrice: vi.fn(),
	isSsoSubscription: vi.fn(),
	STRIPE_SAML_SSO_PRICE_ID: "price",
}));

import {
	attachSsoCheckout,
	createSsoBillingPortal,
	createSsoCheckout,
	getSsoBilling,
	getSsoBillingForSubscription,
	getSsoPrices,
	listSsoInvoices,
	syncSsoSubscription,
} from "@/lib/sso/billing";

afterEach(() => vi.unstubAllEnvs());
it("keeps Cap Cloud SAML billing outside the Cloudflare deployment", async () => {
	vi.stubEnv("CAP_RUNTIME", "cloudflare");
	const organizationId = Organisation.OrganisationId.make("org");
	expect(await getSsoBilling(organizationId)).toBeNull();
	expect(await getSsoBillingForSubscription("sub")).toBeNull();
	expect(await getSsoPrices(organizationId)).toEqual([]);
	for (const action of [
		() => syncSsoSubscription("sub"),
		() => attachSsoCheckout("cs_test"),
		() =>
			createSsoCheckout({
				organizationId,
				purchasedByUserId: User.UserId.make("user"),
				stripeCustomerId: null,
				currency: "usd",
			}),
		() => createSsoBillingPortal(organizationId),
		() => listSsoInvoices(organizationId),
	])
		await expect(action()).rejects.toThrow("self-hosted");
	expect(database).not.toHaveBeenCalled();
	expect(payment).not.toHaveBeenCalled();
});
