import { createCloudflareDb } from "@cap/database/cloudflare";
import {
	createD1BridgeBinding,
	handleD1BridgeRequest,
} from "@cap/database/cloudflare/bridge";
import * as Db from "@cap/database/cloudflare/schema";
import { nanoId } from "@cap/database/helpers";
import {
	CurrentUser,
	DatabaseError,
	ImageUpload,
	type Organisation,
} from "@cap/web-domain";
import { eq } from "drizzle-orm";
import { Effect, Option } from "effect";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createTestDatabase } from "../../../../packages/database/cloudflare/test-runtime.ts";
import { CloudflareDatabase } from "../../../../packages/web-backend/src/CloudflareDatabase";
import { ImageUploads } from "../../../../packages/web-backend/src/ImageUploads";
import { UsersOnboarding } from "../../../../packages/web-backend/src/Users/UsersOnboarding";
import { createTestOwner } from "../helpers/cloudflare-team";

const iconKey = ImageUpload.ImageKey.make("organizations/onboarding-icon.png");
const icon = {
	data: new Uint8Array([1, 2, 3]),
	contentType: "image/png",
	fileName: "icon.png",
};
let fixture: Awaited<ReturnType<typeof createTestDatabase>>;

async function setup(
	options: { owner?: boolean; tombstone?: boolean; missing?: boolean } = {},
) {
	const user = await createTestOwner(fixture.database);
	const other = await createTestOwner(fixture.database);
	const accountWorkspaceId =
		nanoId() as typeof Db.organizations.$inferInsert.id;
	await fixture.database
		.insert(Db.organizations)
		.values({
			id: accountWorkspaceId,
			ownerId: user.id,
			name: "Account workspace",
		});
	await fixture.database
		.insert(Db.organizationMembers)
		.values({
			id: nanoId(),
			userId: user.id,
			organizationId: accountWorkspaceId,
			role: "owner",
		});
	const organizationId = options.owner
		? user.activeOrganizationId
		: other.activeOrganizationId;
	await fixture.database
		.update(Db.organizations)
		.set({
			name: "Company",
			tombstoneAt: options.tombstone ? new Date() : null,
		})
		.where(eq(Db.organizations.id, organizationId));
	await fixture.database
		.update(Db.users)
		.set({
			activeOrganizationId: options.missing
				? ("" as Organisation.OrganisationId)
				: organizationId,
			defaultOrgId: options.missing ? null : user.activeOrganizationId,
			onboardingSteps: { welcome: true, inviteTeam: true },
		})
		.where(eq(Db.users.id, user.id));
	const hooks: {
		beforeOrganizationWrite?: () => Promise<void>;
		beforeIconWrite?: () => Promise<void>;
	} = {};
	const uploadedPrefixes: string[] = [];
	let injected = false;
	const database = createCloudflareDb(
		createD1BridgeBinding({
			fetch: async (request) => {
				const body = await request.clone().text();
				if (
					!injected &&
					hooks.beforeOrganizationWrite &&
					body.includes('update \\"organizations\\"')
				) {
					injected = true;
					await hooks.beforeOrganizationWrite();
				}
				return handleD1BridgeRequest(request, fixture.binding);
			},
		}),
	);
	const service = CloudflareDatabase.make({
		use: (callback) =>
			Effect.tryPromise({
				try: () => callback(database),
				catch: (cause) => new DatabaseError({ cause }),
			}),
	});
	const imageUploads = ImageUploads.make({
		applyUpdate: (args) =>
			Effect.gen(function* () {
				uploadedPrefixes.push(args.keyPrefix);
				if (hooks.beforeIconWrite) yield* Effect.promise(hooks.beforeIconWrite);
				yield* service.use((client) => args.update(client, iconKey));
			}),
		resolveImageUrl: () =>
			Effect.succeed(ImageUpload.ImageUrl.make("https://example.com/icon.png")),
	});
	return {
		user,
		other,
		organizationId,
		hooks,
		uploadedPrefixes,
		readUser: async () =>
			(
				await fixture.database
					.select()
					.from(Db.users)
					.where(eq(Db.users.id, user.id))
			)[0],
		readOrganization: async () =>
			(
				await fixture.database
					.select()
					.from(Db.organizations)
					.where(eq(Db.organizations.id, organizationId))
			)[0],
		run: <A, E>(
			operation: (service: UsersOnboarding) => Effect.Effect<A, E, CurrentUser>,
		) =>
			Effect.runPromise(
				Effect.flatMap(UsersOnboarding, operation).pipe(
					Effect.provide(UsersOnboarding.DefaultWithoutDependencies),
					Effect.provideService(CloudflareDatabase, service),
					Effect.provideService(ImageUploads, imageUploads),
					Effect.provideService(CurrentUser, {
						id: user.id,
						email: user.email,
						activeOrganizationId:
							"stale-session-org" as Organisation.OrganisationId,
						iconUrlOrKey: Option.none(),
					}),
				),
			),
	};
}

describe("onboarding organization authorization on D1", () => {
	beforeAll(async () => {
		fixture = await createTestDatabase();
	});
	afterAll(async () => fixture?.dispose());
	it("lets members complete setup without changing organization metadata or their default", async () => {
		const context = await setup();
		await context.run((service) =>
			service.organizationSetup({
				organizationName: "Replacement",
				organizationIcon: icon,
			}),
		);
		expect(await context.readOrganization()).toMatchObject({
			name: "Company",
			iconUrl: null,
		});
		expect(await context.readUser()).toMatchObject({
			defaultOrgId: context.user.activeOrganizationId,
			onboardingSteps: { organizationSetup: true },
		});
		expect(context.uploadedPrefixes).toEqual([]);
	});
	it("preserves owner name and icon setup", async () => {
		const context = await setup({ owner: true });
		await context.run((service) =>
			service.organizationSetup({
				organizationName: " New Company ",
				organizationIcon: icon,
			}),
		);
		expect(await context.readOrganization()).toMatchObject({
			name: "New Company",
			iconUrl: iconKey,
		});
		expect(context.uploadedPrefixes).toEqual([
			`organizations/${context.organizationId}`,
		]);
	});
	it.each([
		{ owner: true, tombstone: false, name: "Jane's Organization" },
		{ owner: false, tombstone: false, name: "My Organization" },
		{ owner: true, tombstone: true, name: "My Organization" },
	])(
		"personalizes only a live owner's organization ($owner, $tombstone)",
		async (scenario) => {
			const context = await setup(scenario);
			await fixture.database
				.update(Db.organizations)
				.set({ name: "My Organization" })
				.where(eq(Db.organizations.id, context.organizationId));
			await context.run((service) =>
				service.welcome({ firstName: " Jane ", lastName: " Doe " }),
			);
			expect((await context.readOrganization())?.name).toBe(scenario.name);
			expect(await context.readUser()).toMatchObject({
				name: "Jane",
				lastName: "Doe",
				onboardingSteps: { welcome: true, inviteTeam: true },
			});
		},
	);
	it("preserves an owner's previously configured name", async () => {
		const context = await setup({ owner: true });
		await context.run((service) => service.welcome({ firstName: "Jane" }));
		expect((await context.readOrganization())?.name).toBe("Company");
	});
	it("does not replace a tombstoned organization during setup", async () => {
		const context = await setup({ owner: true, tombstone: true });
		await context.run((service) =>
			service.organizationSetup({
				organizationName: "Replacement",
				organizationIcon: icon,
			}),
		);
		expect(await context.readOrganization()).toMatchObject({
			name: "Company",
			iconUrl: null,
		});
		expect(context.uploadedPrefixes).toEqual([]);
	});
	it.each(["ownership", "deletion"] as const)(
		"rechecks %s at the name commit fence",
		async (change) => {
			const context = await setup({ owner: true });
			context.hooks.beforeOrganizationWrite = async () => {
				await fixture.database
					.update(Db.organizations)
					.set(
						change === "ownership"
							? { ownerId: context.other.id }
							: { tombstoneAt: new Date() },
					)
					.where(eq(Db.organizations.id, context.organizationId));
			};
			await context.run((service) =>
				service.organizationSetup({
					organizationName: "Replacement",
					organizationIcon: icon,
				}),
			);
			expect(await context.readOrganization()).toMatchObject({
				name: "Company",
				iconUrl: null,
			});
			expect(context.uploadedPrefixes).toEqual([]);
		},
	);
	it.each(["ownership", "deletion"] as const)(
		"rechecks %s after an icon upload",
		async (change) => {
			const context = await setup({ owner: true });
			context.hooks.beforeIconWrite = async () => {
				await fixture.database
					.update(Db.organizations)
					.set(
						change === "ownership"
							? { ownerId: context.other.id }
							: { tombstoneAt: new Date() },
					)
					.where(eq(Db.organizations.id, context.organizationId));
			};
			await context.run((service) =>
				service.organizationSetup({
					organizationName: "Owner's Update",
					organizationIcon: icon,
				}),
			);
			expect(await context.readOrganization()).toMatchObject({
				name: "Owner's Update",
				iconUrl: null,
			});
			expect(context.uploadedPrefixes).toHaveLength(1);
		},
	);
	it("creates one owned organization for concurrent setup requests without a stored organization", async () => {
		const context = await setup({ missing: true });
		const results = await Promise.all([
			context.run((service) =>
				service.organizationSetup({ organizationName: "New Company" }),
			),
			context.run((service) =>
				service.organizationSetup({ organizationName: "New Company" }),
			),
		]);
		expect(new Set(results.map((result) => result.organizationId)).size).toBe(
			1,
		);
		expect((await context.readUser())?.defaultOrgId).toBe(
			results[0]?.organizationId,
		);
	});
	it.each(["active", "default"] as const)(
		"uses the stored %s organization when skipping onboarding",
		async (source) => {
			const context = await setup();
			if (source === "default")
				await fixture.database
					.update(Db.users)
					.set({
						activeOrganizationId: "" as Organisation.OrganisationId,
						defaultOrgId: context.organizationId,
					})
					.where(eq(Db.users.id, context.user.id));
			await context.run((service) => service.skipToDashboard());
			expect((await context.readOrganization())?.name).toBe("Company");
			expect(
				(await context.readUser())?.onboardingSteps?.organizationSetup,
			).toBe(true);
		},
	);
});
