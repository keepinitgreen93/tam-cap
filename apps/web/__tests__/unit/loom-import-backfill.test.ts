import {
	folders,
	importedVideos,
	sharedVideos,
	users,
	videos,
} from "@cap/database/cloudflare/schema";
import { nanoId } from "@cap/database/helpers";
import { and, eq } from "drizzle-orm";
import {
	afterAll,
	afterEach,
	beforeAll,
	beforeEach,
	describe,
	expect,
	it,
	vi,
} from "vitest";
import { createTestDatabase } from "../../../../packages/database/cloudflare/test-runtime.ts";
import { createTestTeam } from "../helpers/cloudflare-team";

const state = vi.hoisted(() => ({
	database: undefined as
		| Awaited<ReturnType<typeof createTestDatabase>>["database"]
		| undefined,
	reassign: vi.fn(),
}));
vi.mock("server-only", () => ({}));
vi.mock("@cap/database/cloudflare/application", () => ({
	db: () => state.database,
}));
vi.mock("@cap/env", () => ({
	buildEnv: { NEXT_PUBLIC_IS_CAP: "false" },
	serverEnv: () => ({}),
}));
vi.mock("@/lib/loom-import-reassign", () => ({
	reassignLoomImport: state.reassign,
}));

import {
	backfillLoomImport,
	type LoomBackfillItem,
} from "@/lib/loom-import-backfill";

let runtime: Awaited<ReturnType<typeof createTestDatabase>>;
let team: Awaited<ReturnType<typeof createTestTeam>>;
let videoId: typeof videos.$inferSelect.id;
let ownFolder: typeof folders.$inferSelect.id;
let targetFolder: typeof folders.$inferSelect.id;
const invoke = (item: Partial<LoomBackfillItem> = {}) =>
	backfillLoomImport(
		team.owner.activeOrganizationId,
		{ videoId, ...item },
		team.owner.id,
	);
async function currentVideo() {
	const [video] = await runtime.database
		.select()
		.from(videos)
		.where(eq(videos.id, videoId));
	if (!video) throw new Error("Fixture missing");
	return video;
}
describe("Loom metadata backfill on D1", () => {
	beforeAll(async () => {
		runtime = await createTestDatabase();
		state.database = runtime.database;
	});
	afterAll(async () => runtime.dispose());
	afterEach(() => vi.unstubAllEnvs());
	beforeEach(async () => {
		team = await createTestTeam(runtime.database);
		vi.stubEnv("CAP_RUNTIME", "cloudflare");
		vi.stubEnv("CAP_OWNER_EMAIL", team.owner.email);
		videoId = nanoId() as typeof videos.$inferSelect.id;
		ownFolder = nanoId() as typeof folders.$inferSelect.id;
		targetFolder = nanoId() as typeof folders.$inferSelect.id;
		await runtime.database.insert(folders).values([
			{
				id: ownFolder,
				name: "Old personal folder",
				organizationId: team.owner.activeOrganizationId,
				createdById: team.owner.id,
			},
			{
				id: targetFolder,
				name: "Target personal folder",
				organizationId: team.owner.activeOrganizationId,
				createdById: team.user.id,
			},
		]);
		await runtime.database
			.insert(videos)
			.values({
				id: videoId,
				ownerId: team.owner.id,
				orgId: team.owner.activeOrganizationId,
				folderId: ownFolder,
				name: "Backfill",
				source: { type: "webMP4" },
				createdAt: new Date("2026-09-23T10:00:00Z"),
			});
		await runtime.database
			.insert(importedVideos)
			.values({
				id: videoId,
				orgId: team.owner.activeOrganizationId,
				source: "loom",
				sourceId: nanoId(),
			});
		state.reassign.mockReset().mockImplementation(async (input) => {
			await runtime.database
				.update(videos)
				.set({ ownerId: input.toUserId, folderId: input.options.folderId })
				.where(eq(videos.id, videoId));
			return { status: "moved", copiedObjects: 3, cleanup: "done" };
		});
	});
	it("moves into the target owner's sheet folder while preserving sharing", async () => {
		expect(
			await invoke({
				ownerEmail: team.user.email.toUpperCase(),
				folderId: targetFolder,
			}),
		).toMatchObject({ status: "updated", changes: ["owner", "folder"] });
		expect(state.reassign).toHaveBeenCalledWith(
			expect.objectContaining({
				operatorId: team.owner.id,
				toUserId: team.user.id,
				options: { keepSharing: true, folderId: targetFolder },
			}),
		);
		expect((await currentVideo()).ownerId).toBe(team.user.id);
	});
	it("clears inherited folders inaccessible to the new owner", async () => {
		await invoke({ ownerEmail: team.user.email });
		expect((await currentVideo()).folderId).toBeNull();
	});
	it("provisions missing owners through the existing invitation contract", async () => {
		const email = `${nanoId()}@example.com`;
		await invoke({ ownerEmail: email });
		const [user] = await runtime.database
			.select()
			.from(users)
			.where(eq(users.email, email));
		expect(user).toBeDefined();
		expect((await currentVideo()).ownerId).toBe(user?.id);
	});
	it("does not provision invalid owner emails", async () => {
		expect(await invoke({ ownerEmail: "invalid" })).toMatchObject({
			status: "skipped",
			reason: "invalid owner email",
		});
		expect(state.reassign).not.toHaveBeenCalled();
	});
	it("leaves matching ownership alone", async () => {
		expect(await invoke({ ownerEmail: team.owner.email })).toMatchObject({
			status: "unchanged",
		});
		expect(state.reassign).not.toHaveBeenCalled();
	});
	it("updates date and folder together without replacing sibling metadata", async () => {
		await runtime.database
			.update(videos)
			.set({ metadata: { summary: "Preserve me" } })
			.where(eq(videos.id, videoId));
		const date = "2023-09-14T16:11:20.773Z";
		const second = nanoId() as typeof folders.$inferSelect.id;
		await runtime.database
			.insert(folders)
			.values({
				id: second,
				name: "Second",
				createdById: team.owner.id,
				organizationId: team.owner.activeOrganizationId,
			});
		expect(
			await invoke({ folderId: second, effectiveCreatedAt: date }),
		).toMatchObject({ status: "updated" });
		expect(await currentVideo()).toMatchObject({
			folderId: second,
			metadata: { summary: "Preserve me", customCreatedAt: date },
		});
	});
	it("skips matching dates", async () => {
		expect(
			await invoke({ effectiveCreatedAt: "2026-09-23T10:00:00.000Z" }),
		).toMatchObject({ status: "unchanged" });
	});
	it("shares into a team folder once and folds duplicate shares", async () => {
		const folderId = nanoId() as typeof folders.$inferSelect.id;
		await runtime.database
			.insert(folders)
			.values({
				id: folderId,
				name: "Shared",
				organizationId: team.owner.activeOrganizationId,
				spaceId: team.owner.activeOrganizationId,
				createdById: team.owner.id,
			});
		await invoke({ shareFolderId: folderId });
		await runtime.database
			.insert(sharedVideos)
			.values({
				id: nanoId(),
				videoId,
				organizationId: team.owner.activeOrganizationId,
				sharedByUserId: team.owner.id,
			});
		expect(await invoke({ shareFolderId: folderId })).toMatchObject({
			changes: ["shared"],
		});
		expect(
			await runtime.database
				.select()
				.from(sharedVideos)
				.where(
					and(
						eq(sharedVideos.videoId, videoId),
						eq(sharedVideos.organizationId, team.owner.activeOrganizationId),
					),
				),
		).toHaveLength(1);
	});
	it("skips recordings without a Loom mapping", async () => {
		await runtime.database
			.delete(importedVideos)
			.where(eq(importedVideos.id, videoId));
		expect(await invoke()).toMatchObject({
			status: "skipped",
			reason: "not a Loom import here",
		});
	});
	it("rejects missing and other-owner personal folders", async () => {
		expect(await invoke({ folderId: nanoId() })).toMatchObject({
			status: "skipped",
			reason: "folder not in this workspace",
		});
		expect(await invoke({ folderId: targetFolder })).toMatchObject({
			status: "skipped",
			reason: "folder belongs to someone other than the owner",
		});
	});
	it("does not put a reassigned video in the organization owner's private folder", async () => {
		expect(
			await invoke({ ownerEmail: team.user.email, folderId: ownFolder }),
		).toMatchObject({ status: "skipped" });
		expect(state.reassign).not.toHaveBeenCalled();
	});
	it("repairs pending original keys left under the previous owner's prefix", async () => {
		await runtime.database
			.update(videos)
			.set({
				metadata: {
					loomDeferredProcessing: {
						status: "pending",
						rawFileKey: `old-owner/${videoId}/raw-upload.webm`,
					},
				},
			})
			.where(eq(videos.id, videoId));
		expect(await invoke()).toMatchObject({ changes: ["original"] });
		expect(
			(await currentVideo()).metadata?.loomDeferredProcessing?.rawFileKey,
		).toBe(`${team.owner.id}/${videoId}/raw-upload.webm`);
	});
	it("leaves matching original keys alone", async () => {
		await runtime.database
			.update(videos)
			.set({
				metadata: {
					loomDeferredProcessing: {
						status: "pending",
						rawFileKey: `${team.owner.id}/${videoId}/raw-upload.webm`,
					},
				},
			})
			.where(eq(videos.id, videoId));
		expect(await invoke()).toMatchObject({ status: "unchanged" });
	});
	it("reports skipped moves and retained-copy warnings", async () => {
		state.reassign.mockResolvedValueOnce({ status: "skipped", reason: "busy" });
		expect(await invoke({ ownerEmail: team.user.email })).toMatchObject({
			status: "skipped",
			reason: "busy",
		});
		state.reassign.mockImplementationOnce(async (input) => {
			await runtime.database
				.update(videos)
				.set({ ownerId: input.toUserId, folderId: null })
				.where(eq(videos.id, videoId));
			return { status: "moved", copiedObjects: 3, cleanup: "failed" };
		});
		expect(await invoke({ ownerEmail: team.user.email })).toMatchObject({
			status: "updated",
			warning: "old owner media copies retained for safe cleanup",
		});
	});
	it("rechecks configured operator verification before committing metadata", async () => {
		await runtime.database
			.update(users)
			.set({ emailVerified: null })
			.where(eq(users.id, team.owner.id));
		await expect(
			invoke({ effectiveCreatedAt: "2020-01-01T00:00:00Z" }),
		).rejects.toThrow("Unauthorized");
		expect((await currentVideo()).metadata?.customCreatedAt).toBeUndefined();
	});
});
