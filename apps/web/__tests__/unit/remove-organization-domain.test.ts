import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
	updates: [] as unknown[],
}));

vi.mock("@cap/database/auth/session", () => ({
	getCurrentUser: async () => ({ id: "owner" }),
}));

vi.mock("@cap/database/cloudflare/application", () => ({
	db: () => ({
		select: () => ({
			from: () => ({
				where: async () => [{ id: "org", customDomain: "video.example.com" }],
			}),
		}),
		update: () => ({
			set: (values: unknown) => ({
				where: async () => {
					mocks.updates.push(values);
				},
			}),
		}),
	}),
}));

vi.mock("@/actions/organization/authorization", () => ({
	requireOrganizationSettingsManager: async () => ({}),
}));

vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));

import type { Organisation } from "@cap/web-domain";
import { removeOrganizationDomain } from "@/actions/organization/remove-domain";

const organizationId = "org" as Organisation.OrganisationId;

describe("removeOrganizationDomain", () => {
	beforeEach(() => {
		mocks.updates = [];
		vi.unstubAllGlobals();
		vi.unstubAllEnvs();
	});

	it("keeps the domain when the provider rejects removal", async () => {
		vi.stubGlobal(
			"fetch",
			vi.fn().mockResolvedValue(new Response(null, { status: 403 })),
		);

		await expect(removeOrganizationDomain(organizationId)).rejects.toThrow();
		expect(mocks.updates).toEqual([]);
	});

	it("clears the domain after the provider removes it", async () => {
		vi.stubGlobal(
			"fetch",
			vi.fn().mockResolvedValue(new Response(null, { status: 204 })),
		);

		await expect(removeOrganizationDomain(organizationId)).resolves.toEqual({
			success: true,
		});
		expect(mocks.updates).toEqual([
			{ customDomain: null, domainVerified: null },
		]);
	});

	it("clears a domain that is already absent at the provider", async () => {
		vi.stubGlobal(
			"fetch",
			vi.fn().mockResolvedValue(new Response(null, { status: 404 })),
		);

		await expect(removeOrganizationDomain(organizationId)).resolves.toEqual({
			success: true,
		});
		expect(mocks.updates).toHaveLength(1);
	});
	it("leaves operator-managed Cloudflare domains unchanged without contacting Vercel", async () => {
		vi.stubEnv("CAP_RUNTIME", "cloudflare");
		const fetchMock = vi.fn();
		vi.stubGlobal("fetch", fetchMock);
		await expect(removeOrganizationDomain(organizationId)).rejects.toThrow(
			"deployment operator",
		);
		expect(fetchMock).not.toHaveBeenCalled();
		expect(mocks.updates).toEqual([]);
		vi.unstubAllEnvs();
	});
});
