import { Organisation, User } from "@cap/web-domain";
import { NextRequest } from "next/server";
import type Stripe from "stripe";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

const calls = vi.hoisted(() => ({
	database: vi.fn(),
	auth: vi.fn(),
	stripe: vi.fn(),
	mail: vi.fn(),
	pdf: vi.fn(),
}));
vi.mock("server-only", () => ({}));
vi.mock("@cap/database/legacy", () => ({ db: calls.database }));
vi.mock("@cap/database/cloudflare/application", () => ({ db: calls.database }));
vi.mock("@cap/database/auth/session", () => ({ getCurrentUser: calls.auth }));
vi.mock("@cap/database/emails/config", () => ({ sendEmail: calls.mail }));
vi.mock("@cap/database/emails/signed-baa", () => ({ SignedBaa: () => null }));
vi.mock("@/lib/baa/generate-signed-baa-pdf", () => ({
	generateSignedBaaPdf: calls.pdf,
	formatBaaDate: () => "date",
}));
vi.mock("@cap/utils", async (original) => ({
	...(await original<typeof import("@cap/utils")>()),
	stripe: calls.stripe,
}));

import { checkOrganizationDomain } from "@/actions/organization/check-domain";
import { manageBilling } from "@/actions/organization/manage-billing";
import {
	confirmSignedBaaPayment,
	getSignedBaaStatus,
	purchaseSignedBaa,
	signPaidBaa,
} from "@/actions/organization/signed-baa";
import {
	manageOrganizationSsoBilling,
	openOrganizationSsoPortal,
	startOrganizationSsoCheckout,
} from "@/actions/organization/sso";
import { updateDomain } from "@/actions/organization/update-domain";
import {
	previewSeatChange,
	updateSeatQuantity,
} from "@/actions/organization/update-seat-quantity";
import { GET as downloadBaa } from "@/app/api/settings/billing/baa/download/route";
import { POST as manage } from "@/app/api/settings/billing/manage/route";
import { POST as subscribe } from "@/app/api/settings/billing/subscribe/route";
import { attachPaidBaaCheckout, ensureBaaHasPro } from "@/lib/baa/billing";
import { ensureWorkosOrganization } from "@/lib/sso/workos";

beforeEach(() => {
	vi.stubEnv("CAP_RUNTIME", "cloudflare");
	vi.clearAllMocks();
	for (const callback of Object.values(calls))
		callback.mockImplementation(() => {
			throw new Error("External operation must not run");
		});
});
afterEach(() => vi.unstubAllEnvs());
const organizationId = Organisation.OrganisationId.make("org123");

it("blocks hosted billing, seat charging, domain and SSO provisioning before any auth/database/provider call", async () => {
	for (const action of [
		() => manageBilling(),
		() => previewSeatChange(organizationId, 2),
		() => updateSeatQuantity(organizationId, 2),
		() => updateDomain("example.com", organizationId),
		() => checkOrganizationDomain(organizationId),
		() => startOrganizationSsoCheckout(organizationId, "usd"),
		() => openOrganizationSsoPortal(organizationId),
		() => manageOrganizationSsoBilling(organizationId),
		() => ensureWorkosOrganization(organizationId),
	])
		await expect(action()).rejects.toThrow(/self-hosted|instance's operator/);
	for (const callback of Object.values(calls))
		expect(callback).not.toHaveBeenCalled();
});

it("returns explicit billing HTTP denials without parsing input or accessing providers", async () => {
	const request = new NextRequest(
		"https://videos.example.com/api/settings/billing/subscribe",
		{ method: "POST", body: "not json" },
	);
	for (const handler of [manage, subscribe, downloadBaa]) {
		const response = await handler(request);
		expect(response.status).toBe(403);
		expect(await response.json()).toMatchObject({ error: expect.anything() });
	}
	for (const callback of Object.values(calls))
		expect(callback).not.toHaveBeenCalled();
});

it("does not sell, generate, attach or cancel upstream BAA contracts on Cloudflare", async () => {
	expect(await getSignedBaaStatus(organizationId)).toMatchObject({
		status: "none",
		canPurchase: false,
	});
	const input = {
		entityName: "Test",
		entityType: "Test",
		entityAddress: "Test",
		signerName: "Test",
		signerTitle: "Test",
		noticesEmail: "test@example.com",
		signatureDataUrl: "data:image/png;base64,abc",
	};
	for (const action of [purchaseSignedBaa, signPaidBaa])
		expect(await action(organizationId, input)).toMatchObject({
			success: false,
			error: expect.stringContaining("self-hosted"),
		});
	await expect(
		confirmSignedBaaPayment(organizationId, "cs_test"),
	).rejects.toThrow("self-hosted");
	const subscription = { id: "sub_test" } as Stripe.Subscription;
	const session = { id: "cs_test" } as Stripe.Checkout.Session;
	await expect(
		ensureBaaHasPro(
			{ stripeCustomerId: null, stripeSubscriptionId: null },
			subscription,
			{ id: "baa_test", organizationId, userId: User.UserId.make("user123") },
		),
	).rejects.toThrow("self-hosted");
	await expect(attachPaidBaaCheckout(session, subscription)).rejects.toThrow(
		"self-hosted",
	);
	for (const callback of Object.values(calls))
		expect(callback).not.toHaveBeenCalled();
});
