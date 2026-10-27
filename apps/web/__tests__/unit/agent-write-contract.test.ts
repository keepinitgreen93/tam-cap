import {
	agentApiIdempotency,
	comments,
	users,
	videos,
} from "@cap/database/cloudflare/schema";
import { nanoId } from "@cap/database/helpers";
import { type Agent, DatabaseError, Video } from "@cap/web-domain";
import { eq } from "drizzle-orm";
import { Effect } from "effect";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { createTestDatabase } from "../../../../packages/database/cloudflare/test-runtime";
import { CloudflareDatabase } from "../../../../packages/web-backend/src/CloudflareDatabase";
import { createTestOwner } from "../helpers/cloudflare-team";

vi.mock("server-only", () => ({}));
vi.mock("@cap/web-backend", async () => ({
	CloudflareDatabase: (
		await import("../../../../packages/web-backend/src/CloudflareDatabase")
	).CloudflareDatabase,
}));
vi.mock("@/lib/Notification", () => ({ createNotification: vi.fn() }));
vi.mock("@/lib/sync-video-storage-names", () => ({
	enqueueVideoStorageNameSync: vi.fn(async () => undefined),
}));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));

import {
	agentMutationRequestHash,
	createAgentFeedback,
	isAgentIdempotencyKey,
	runAgentExternalMutation,
	runAgentMutation,
	updateAgentCap,
} from "@/lib/agent-write";

let fixture: Awaited<ReturnType<typeof createTestDatabase>>;
let principal: Agent.AgentPrincipal["Type"];
beforeAll(async () => {
	fixture = await createTestDatabase();
	const owner = await createTestOwner(fixture.database);
	principal = {
		id: owner.id,
		email: owner.email,
		activeOrganizationId: owner.activeOrganizationId,
		scopes: new Set(["profile:write"]),
		tokenId: "test",
		tokenKind: "agent",
		expiresAt: null,
	};
});
afterAll(async () => fixture.dispose());
const run = <A, E>(effect: Effect.Effect<A, E, CloudflareDatabase>) =>
	Effect.runPromise(
		effect.pipe(
			Effect.provideService(
				CloudflareDatabase,
				CloudflareDatabase.make({
					use: (callback) =>
						Effect.tryPromise({
							try: () => callback(fixture.database),
							catch: (cause) => new DatabaseError({ cause }),
						}),
				}),
			),
		),
	);
const decode = (value: unknown) => {
	if (typeof value !== "string") throw new Error("Invalid receipt");
	return value;
};
function mutation(key: string, name = "Updated") {
	return runAgentMutation({
		principal,
		operation: "test_update",
		idempotencyKey: key,
		request: { name },
		requestId: "request",
		decodeReplay: decode,
		execute: async (snapshot, database) => {
			const [user] = await snapshot.read((reader) =>
				reader.select().from(users).where(eq(users.id, principal.id)),
			);
			if (!user) return { statements: [], result: { state: "not_found" } };
			return {
				statements: [
					database.update(users).set({ name }).where(eq(users.id, user.id)),
				],
				result: { state: "success", response: name },
			};
		},
	});
}

describe("agent writes on D1", () => {
	it("accepts bounded opaque idempotency keys", () => {
		expect(isAgentIdempotencyKey("0f64ed31-88d5-48bf-b364-a2af210dfa90")).toBe(
			true,
		);
		expect(isAgentIdempotencyKey("short")).toBe(false);
		expect(isAgentIdempotencyKey("contains a secret")).toBe(false);
	});
	it("keeps mutation identity independent of credential rotation", () => {
		const request = { videoId: "cap_test", title: "Updated" };
		expect(agentMutationRequestHash("update_cap", request)).toBe(
			agentMutationRequestHash("update_cap", request),
		);
		expect(agentMutationRequestHash("update_cap", request)).not.toBe(
			agentMutationRequestHash("delete_cap", request),
		);
	});
	it("commits concurrent identical mutations with one durable receipt", async () => {
		expect(
			await Promise.all([
				run(mutation("same-key-123")),
				run(mutation("same-key-123")),
			]),
		).toEqual(["Updated", "Updated"]);
		const records = await fixture.database
			.select()
			.from(agentApiIdempotency)
			.where(eq(agentApiIdempotency.operation, "test_update"));
		expect(records).toHaveLength(1);
		expect(records[0]?.state).toBe("complete");
		await expect(run(mutation("same-key-123", "Different"))).rejects.toThrow(
			"already used",
		);
	});
	it("rolls back both mutation and receipt on a failed batch", async () => {
		const [before] = await fixture.database
			.select()
			.from(users)
			.where(eq(users.id, principal.id));
		await fixture.binding
			.prepare(
				"CREATE TRIGGER reject_receipt BEFORE UPDATE ON agent_api_idempotency WHEN NEW.state = 'complete' BEGIN SELECT RAISE(ABORT, 'reject receipt'); END",
			)
			.run();
		try {
			await expect(
				run(mutation("rollback-key", "Must not persist")),
			).rejects.toThrow();
			expect(
				(
					await fixture.database
						.select()
						.from(users)
						.where(eq(users.id, principal.id))
				)[0]?.name,
			).toBe(before?.name);
		} finally {
			await fixture.binding.prepare("DROP TRIGGER reject_receipt").run();
		}
		expect(await run(mutation("rollback-key", "Retry succeeds"))).toBe(
			"Retry succeeds",
		);
	});
	it("serializes external retries, then replays the saved result", async () => {
		let release: (() => void) | undefined;
		let entered: (() => void) | undefined;
		const started = new Promise<void>((resolve) => {
			entered = resolve;
		});
		const waiting = new Promise<void>((resolve) => {
			release = resolve;
		});
		const provider = vi.fn(() =>
			Effect.promise(async () => {
				entered?.();
				await waiting;
				return "external-result";
			}),
		);
		const external = () =>
			runAgentExternalMutation({
				principal,
				operation: "external",
				idempotencyKey: "external-key",
				request: {},
				requestId: "request",
				decodeReplay: decode,
				execute: provider,
			});
		const first = run(external());
		await started;
		await expect(run(external())).rejects.toThrow("could not be completed");
		release?.();
		expect(await first).toBe("external-result");
		expect(await run(external())).toBe("external-result");
		expect(provider).toHaveBeenCalledTimes(1);
	});
	it("releases failed external claims so a retry can succeed", async () => {
		const input = {
			principal,
			operation: "external_failure",
			idempotencyKey: "failed-external",
			request: {},
			requestId: "request",
			decodeReplay: decode,
		};
		await expect(
			run(
				runAgentExternalMutation({
					...input,
					execute: () => Effect.fail(new Error("provider failed")),
				}),
			),
		).rejects.toThrow("provider failed");
		expect(
			await run(
				runAgentExternalMutation({
					...input,
					execute: () => Effect.succeed("recovered"),
				}),
			),
		).toBe("recovered");
	});
	it("updates a Cap and replays the exact committed response", async () => {
		const id = Video.VideoId.make(nanoId());
		await fixture.database
			.insert(videos)
			.values({
				id,
				ownerId: principal.id,
				orgId: principal.activeOrganizationId,
				name: "Original",
				source: { type: "webMP4" },
				metadata: { customCreatedAt: "2026-01-01T00:00:00Z" },
			});
		const input = {
			videoId: id,
			principal,
			title: "Changed",
			public: false,
			idempotencyKey: "update-cap-key",
			requestId: "first",
		};
		const first = await run(updateAgentCap(input));
		expect(await run(updateAgentCap({ ...input, requestId: "retry" }))).toEqual(
			first,
		);
		const [row] = await fixture.database
			.select()
			.from(videos)
			.where(eq(videos.id, id));
		expect(row?.name).toBe("Changed");
		expect(row?.metadata).toMatchObject({
			titleManuallyEdited: true,
			customCreatedAt: "2026-01-01T00:00:00Z",
		});
	});
	it("creates one feedback comment under concurrent duplicate requests", async () => {
		const id = Video.VideoId.make(nanoId());
		await fixture.database
			.insert(videos)
			.values({
				id,
				ownerId: principal.id,
				orgId: principal.activeOrganizationId,
				name: "Feedback",
				source: { type: "webMP4" },
			});
		const input = {
			videoId: id,
			principal,
			type: "text" as const,
			content: " Comment ",
			timestampMs: 700,
			parentCommentId: null,
			idempotencyKey: "feedback-key",
			requestId: "request",
			durationMs: 10000,
		};
		const responses = await Promise.all([
			run(createAgentFeedback(input)),
			run(createAgentFeedback(input)),
		]);
		expect(responses[0]?.id).toBe(responses[1]?.id);
		const rows = await fixture.database
			.select()
			.from(comments)
			.where(eq(comments.videoId, id));
		expect(rows).toHaveLength(1);
		expect(rows[0]?.timestamp).toBe(0.7);
	});
});
