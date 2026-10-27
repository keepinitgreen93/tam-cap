import { createCloudflareDb } from "@cap/database/cloudflare";
import {
	createD1BridgeBinding,
	handleD1BridgeRequest,
} from "@cap/database/cloudflare/bridge";
import * as Db from "@cap/database/cloudflare/schema";
import { Folder, Organisation, User, Video } from "@cap/web-domain";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, expect, it, vi } from "vitest";
import { createTestDatabase } from "../../../../packages/database/cloudflare/test-runtime";

const state = vi.hoisted(() => ({
	database: undefined as ReturnType<typeof createCloudflareDb> | undefined,
	user: undefined as
		| { id: User.UserId; activeOrganizationId: Organisation.OrganisationId }
		| undefined,
	start: vi.fn(),
}));
vi.mock("@cap/database/cloudflare/application", () => ({
	db: () => {
		if (!state.database) throw Error("Missing fixture");
		return state.database;
	},
}));
vi.mock("@cap/database/auth/session", () => ({
	getCurrentUser: async () => state.user,
}));
vi.mock("workflow/api", () => ({ start: state.start }));
vi.mock("@/workflows/transfer-organization-content", () => ({
	transferOrganizationContentWorkflow: vi.fn(),
}));

import {
	getContentTransferFolders,
	getContentTransferPreview,
	startContentTransfer,
} from "@/actions/organization/content-transfer";

let runtime: Awaited<ReturnType<typeof createTestDatabase>>,
	beforeBatch: (() => Promise<void>) | undefined,
	sequence = 0;
beforeAll(async () => {
	runtime = await createTestDatabase();
	state.database = createCloudflareDb(
		createD1BridgeBinding({
			fetch: async (request) => {
				const payload = (await request.clone().json()) as { operation: string };
				if (payload.operation === "batch" && beforeBatch) {
					const hook = beforeBatch;
					beforeBatch = undefined;
					await hook();
				}
				return handleD1BridgeRequest(request, runtime.binding);
			},
		}),
	);
}, 60000);
afterAll(async () => runtime?.dispose());
async function fixture() {
	const s = String(++sequence),
		actor = User.UserId.make(`ctactor${s}`),
		owner = User.UserId.make(`ctowner${s}`),
		target = User.UserId.make(`cttarget${s}`),
		orgId = Organisation.OrganisationId.make(`ctorg${s}`),
		folderId = Folder.FolderId.make(`ctfolder${s}`),
		videoId = Video.VideoId.make(`ctvideo${s}`);
	await runtime.database.insert(Db.users).values(
		[actor, owner, target].map((id) => ({
			id,
			email: `${id}@transfer.test`,
			activeOrganizationId: orgId,
		})),
	);
	await runtime.database
		.insert(Db.organizations)
		.values({ id: orgId, ownerId: owner, name: "Transfer" });
	await runtime.database.insert(Db.organizationMembers).values([
		{ id: `cta${s}`, organizationId: orgId, userId: actor, role: "admin" },
		{ id: `ctt${s}`, organizationId: orgId, userId: target, role: "member" },
	]);
	await runtime.database.insert(Db.folders).values({
		id: folderId,
		organizationId: orgId,
		createdById: actor,
		spaceId: orgId,
		name: "Source",
	});
	await runtime.database.insert(Db.videos).values({
		id: videoId,
		ownerId: actor,
		orgId,
		name: "Video",
		source: { type: "webMP4" },
	});
	await runtime.database.insert(Db.sharedVideos).values({
		id: `cts${s}`,
		videoId,
		folderId,
		organizationId: orgId,
		sharedByUserId: actor,
	});
	state.user = { id: actor, activeOrganizationId: orgId };
	state.start.mockReset().mockResolvedValue({ runId: "run" });
	const input = {
		source: { type: "organization" as const },
		sourceRootFolderId: folderId,
		targetUserId: target,
	};
	const preview = await getContentTransferPreview(input);
	return {
		s,
		actor,
		target,
		orgId,
		folderId,
		videoId,
		input: { ...input, previewToken: preview.previewToken },
	};
}
it("serializes concurrent transfer starts and dispatches one workflow", async () => {
	const f = await fixture();
	const results = await Promise.allSettled([
		startContentTransfer(f.input),
		startContentTransfer(f.input),
	]);
	expect(
		results.filter((result) => result.status === "fulfilled"),
	).toHaveLength(1);
	expect(results.filter((result) => result.status === "rejected")).toHaveLength(
		1,
	);
	expect(state.start).toHaveBeenCalledOnce();
	expect(
		await runtime.database
			.select()
			.from(Db.agentApiOperations)
			.where(eq(Db.agentApiOperations.resourceId, f.orgId)),
	).toHaveLength(1);
});
it.each(["actor", "target", "folder"] as const)(
	"rechecks a concurrent %s change before transfer reservation",
	async (change) => {
		const f = await fixture();
		beforeBatch = async () => {
			if (change === "folder")
				await runtime.database
					.update(Db.folders)
					.set({ name: "Changed" })
					.where(eq(Db.folders.id, f.folderId));
			else
				await runtime.database
					.delete(Db.organizationMembers)
					.where(
						eq(
							Db.organizationMembers.userId,
							change === "actor" ? f.actor : f.target,
						),
					);
		};
		await expect(startContentTransfer(f.input)).rejects.toThrow();
		expect(state.start).not.toHaveBeenCalled();
		expect(
			await runtime.database
				.select()
				.from(Db.agentApiOperations)
				.where(eq(Db.agentApiOperations.resourceId, f.orgId)),
		).toEqual([]);
	},
);
it("counts folders using a bounded JSON selection beyond one hundred IDs", async () => {
	const f = await fixture();
	for (let start = 0; start < 120; start += 10)
		await runtime.database.insert(Db.folders).values(
			Array.from({ length: 10 }, (_, offset) => ({
				id: Folder.FolderId.make(`ctf${f.s}-${start + offset}`),
				organizationId: f.orgId,
				createdById: f.actor,
				spaceId: f.orgId,
				parentId: f.folderId,
				name: `Folder ${start + offset}`,
			})),
		);
	const folders = await getContentTransferFolders({ type: "organization" });
	expect(folders).toHaveLength(121);
	expect(folders.find((folder) => folder.id === f.folderId)?.videoCount).toBe(
		1,
	);
});
