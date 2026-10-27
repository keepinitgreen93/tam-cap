import type { CloudflareDatabase } from "@cap/database/cloudflare";
import { agentApiOperations, videos } from "@cap/database/cloudflare/schema";
import { nanoId } from "@cap/database/helpers";
import { Video } from "@cap/web-domain";
import { eq } from "drizzle-orm";
import { Effect } from "effect";
import { afterAll, beforeAll, expect, it, vi } from "vitest";
import { createTestDatabase } from "../../../../packages/database/cloudflare/test-runtime";
import { createTestOwner } from "../helpers/cloudflare-team";

let fixture: Awaited<ReturnType<typeof createTestDatabase>>;
let database: CloudflareDatabase;
const copies = vi.hoisted(() => vi.fn());
const syncNames = vi.hoisted(() => vi.fn());
vi.mock("@cap/database/cloudflare/application", () => ({ db: () => database }));
vi.mock("@cap/web-backend/src/Organisations/index", () => ({
	Organisations: {},
}));
vi.mock("@cap/web-backend/src/Storage/index", () => ({
	Storage: {
		getAccessForVideo: () =>
			Effect.succeed([
				{
					bucketName: "test",
					listObjects: () =>
						Effect.succeed({ Contents: [{ Key: "source/raw.mp4" }] }),
					copyObject: () => Effect.sync(() => copies()),
					deleteObjects: () => Effect.void,
				},
			]),
	},
}));
vi.mock("@/lib/workflow-runtime", () => ({
	runWorkflowPromise: Effect.runPromise,
}));
vi.mock("@/actions/organization/domain-utils", () => ({}));
vi.mock("@/lib/ai-generation-entitlement", () => ({}));
vi.mock("@/lib/sync-video-storage-names", () => ({
	enqueueVideoStorageNameSync: syncNames,
}));

import { agentCapOperationWorkflow } from "@/workflows/agent-cap-operation";

beforeAll(async () => {
	fixture = await createTestDatabase();
	database = fixture.database;
});
afterAll(async () => fixture.dispose());

async function operation(kind: "duplicate_cap" | "delete_cap") {
	const owner = await createTestOwner(database);
	const id = Video.VideoId.make(nanoId());
	await database.insert(videos).values({
		id,
		ownerId: owner.id,
		orgId: owner.activeOrganizationId,
		name: "Original",
		source: { type: "webMP4" },
	});
	const [source] = await database
		.select()
		.from(videos)
		.where(eq(videos.id, id));
	const operationId = nanoId();
	const destinationId = Video.VideoId.make(nanoId());
	await database.insert(agentApiOperations).values({
		id: operationId,
		userId: owner.id,
		kind,
		resourceId: id,
		resultResourceId: destinationId,
		payload: { snapshot: source, destinationId },
	});
	return { id, operationId, destinationId };
}

it("claims one duplicate workflow across concurrent starts and preserves completion on replay", async () => {
	const input = await operation("duplicate_cap");
	await Promise.all([
		agentCapOperationWorkflow(input),
		agentCapOperationWorkflow(input),
	]);
	expect(copies).toHaveBeenCalledTimes(1);
	expect(
		(
			await database
				.select()
				.from(videos)
				.where(eq(videos.id, input.destinationId))
		)[0]?.name,
	).toBe("Original");
	expect(
		(
			await database
				.select()
				.from(agentApiOperations)
				.where(eq(agentApiOperations.id, input.operationId))
		)[0]?.state,
	).toBe("succeeded");
	await agentCapOperationWorkflow(input);
	expect(copies).toHaveBeenCalledTimes(1);
});

it("records deletion completion atomically with metadata cleanup", async () => {
	const input = await operation("delete_cap");
	await agentCapOperationWorkflow(input);
	expect(
		await database.select().from(videos).where(eq(videos.id, input.id)),
	).toHaveLength(0);
	expect(
		(
			await database
				.select()
				.from(agentApiOperations)
				.where(eq(agentApiOperations.id, input.operationId))
		)[0]?.result,
	).toEqual({ deleted: true });
});

it("rolls back a new duplicate if recording completion fails", async () => {
	const input = await operation("duplicate_cap");
	await fixture.binding
		.prepare(
			"CREATE TRIGGER reject_operation BEFORE UPDATE ON agent_api_operations WHEN NEW.state = 'succeeded' BEGIN SELECT RAISE(ABORT, 'reject completion'); END",
		)
		.run();
	try {
		await expect(agentCapOperationWorkflow(input)).rejects.toThrow();
		expect(
			await database
				.select()
				.from(videos)
				.where(eq(videos.id, input.destinationId)),
		).toHaveLength(0);
		expect(
			(
				await database
					.select()
					.from(agentApiOperations)
					.where(eq(agentApiOperations.id, input.operationId))
			)[0]?.state,
		).toBe("failed");
	} finally {
		await fixture.binding.prepare("DROP TRIGGER reject_operation").run();
	}
});

it("does not downgrade committed metadata when a later name sync fails", async () => {
	const input = await operation("duplicate_cap");
	syncNames.mockRejectedValueOnce(new Error("name sync failed"));
	await expect(agentCapOperationWorkflow(input)).rejects.toThrow(
		"name sync failed",
	);
	expect(
		(
			await database
				.select()
				.from(agentApiOperations)
				.where(eq(agentApiOperations.id, input.operationId))
		)[0]?.state,
	).toBe("succeeded");
	expect(
		await database
			.select()
			.from(videos)
			.where(eq(videos.id, input.destinationId)),
	).toHaveLength(1);
});
