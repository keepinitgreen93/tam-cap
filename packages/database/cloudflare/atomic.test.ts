import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { after, before, test } from "node:test";
import { eq, sql } from "drizzle-orm";
import { Miniflare } from "miniflare";
import { DrizzleAdapter } from "../auth/drizzle-adapter.ts";
import { normalizeEmail } from "../auth/identity.ts";
import { requireActiveOrganization } from "./access.ts";
import { AtomicConflictError, atomic } from "./atomic.ts";
import { createD1BridgeBinding, handleD1BridgeRequest } from "./bridge.ts";
import { createCloudflareDb } from "./index.ts";
import {
	beginOrganizationDeletion,
	finishOrganizationDeletion,
} from "./organization-delete.ts";
import {
	mediaProcessingBudgets,
	organizationInvites,
	organizationMembers,
	organizations,
	users,
	videoProcessingJobs,
	videos,
} from "./schema.ts";
import {
	canSignInCloudflare,
	createCloudflareUser,
	provisionCloudflareInvitee,
} from "./team.ts";

const runtime = new Miniflare({
	modules: true,
	script: "export default { fetch() { return new Response('test'); } }",
	compatibilityDate: "2025-02-04",
	d1Databases: { DB: "cap-atomic-test" },
});
let binding: Awaited<ReturnType<typeof runtime.getD1Database>>;
let database: ReturnType<typeof createCloudflareDb>;

before(async () => {
	binding = await runtime.getD1Database("DB");
	const journal = JSON.parse(
		await readFile(
			new URL("./migrations/meta/_journal.json", import.meta.url),
			"utf8",
		),
	) as { entries: { tag: string }[] };
	for (const entry of journal.entries) {
		const migration = await readFile(
			new URL(`./migrations/${entry.tag}.sql`, import.meta.url),
			"utf8",
		);
		for (const statement of migration.split("--> statement-breakpoint")) {
			if (statement.trim()) await binding.prepare(statement).run();
		}
	}
	database = createCloudflareDb(
		createD1BridgeBinding({
			fetch: (request) => handleD1BridgeRequest(new Request(request), binding),
		}),
	);
});

after(async () => runtime.dispose());

const budget = (id: string) => ({
	id,
	limitBytes: 100,
	reservedBytes: 0,
	expiresAt: new Date("2030-01-01"),
});

test("bridge preserves dates, raw positional rows, mutation counts, and batch mapping", async () => {
	const inserted = await database
		.insert(mediaProcessingBudgets)
		.values(budget("bridge"));
	assert.equal(inserted.meta.changes, 1);
	const [row] = await database
		.select()
		.from(mediaProcessingBudgets)
		.where(eq(mediaProcessingBudgets.id, "bridge"));
	assert.equal(row?.expiresAt.toISOString(), "2030-01-01T00:00:00.000Z");
	const results = await database.batch([
		database
			.update(mediaProcessingBudgets)
			.set({ reservedBytes: 2 })
			.where(eq(mediaProcessingBudgets.id, "bridge"))
			.returning({ bytes: mediaProcessingBudgets.reservedBytes }),
		database
			.select({ bytes: mediaProcessingBudgets.reservedBytes })
			.from(mediaProcessingBudgets)
			.where(eq(mediaProcessingBudgets.id, "bridge")),
	]);
	assert.deepEqual(results, [[{ bytes: 2 }], [{ bytes: 2 }]]);
});

test("concurrent plans retry without losing increments or exceeding a quota", async () => {
	await database.insert(mediaProcessingBudgets).values(budget("race"));
	let plans = 0;
	const reserve = () =>
		atomic(
			database,
			async (snapshot) => {
				plans++;
				const [row] = await snapshot.read((reader) =>
					reader
						.select()
						.from(mediaProcessingBudgets)
						.where(eq(mediaProcessingBudgets.id, "race")),
				);
				assert.ok(row);
				if (row.reservedBytes + 30 > row.limitBytes)
					return { statements: [], result: false };
				return {
					statements: [
						database
							.update(mediaProcessingBudgets)
							.set({ reservedBytes: row.reservedBytes + 30 })
							.where(eq(mediaProcessingBudgets.id, "race")),
					],
					result: true,
				};
			},
			{ maxAttempts: 20 },
		);
	const results = await Promise.all(Array.from({ length: 8 }, reserve));
	assert.equal(results.filter(Boolean).length, 3);
	assert.ok(plans > 8);
	const [row] = await database
		.select()
		.from(mediaProcessingBudgets)
		.where(eq(mediaProcessingBudgets.id, "race"));
	assert.equal(row?.reservedBytes, 90);
});

test("a write between snapshot reads forces a new plan", async () => {
	await database.insert(mediaProcessingBudgets).values(budget("snapshot"));
	let attempts = 0;
	const value = await atomic(database, async (snapshot) => {
		attempts++;
		const [row] = await snapshot.read((reader) =>
			reader
				.select()
				.from(mediaProcessingBudgets)
				.where(eq(mediaProcessingBudgets.id, "snapshot")),
		);
		assert.ok(row);
		if (attempts === 1)
			await binding
				.prepare(
					"UPDATE media_processing_budgets SET reserved_bytes = 7 WHERE id = ?",
				)
				.bind("snapshot")
				.run();
		return { statements: [], result: row.reservedBytes };
	});
	assert.equal(value, 7);
	assert.equal(attempts, 2);
});

test("constraint failure rolls back all statements and is never retried", async () => {
	await database.insert(mediaProcessingBudgets).values(budget("rollback"));
	let plans = 0;
	await assert.rejects(
		atomic(database, async () => {
			plans++;
			return {
				statements: [
					database
						.update(mediaProcessingBudgets)
						.set({ reservedBytes: 5 })
						.where(eq(mediaProcessingBudgets.id, "rollback")),
					database.insert(mediaProcessingBudgets).values(budget("rollback")),
				],
				result: null,
			};
		}),
		/UNIQUE constraint failed/,
	);
	assert.equal(plans, 1);
	const [row] = await database
		.select()
		.from(mediaProcessingBudgets)
		.where(eq(mediaProcessingBudgets.id, "rollback"));
	assert.equal(row?.reservedBytes, 0);
});

test("conflicts have bounded retries and cannot return an uncommitted result", async () => {
	await database.insert(mediaProcessingBudgets).values(budget("exhausted"));
	let plans = 0;
	await assert.rejects(
		atomic(
			database,
			async () => {
				plans++;
				await database
					.update(mediaProcessingBudgets)
					.set({
						reservedBytes: sql`${mediaProcessingBudgets.reservedBytes} + 1`,
					})
					.where(eq(mediaProcessingBudgets.id, "exhausted"));
				return { statements: [], result: "uncommitted" };
			},
			{ maxAttempts: 3 },
		),
		AtomicConflictError,
	);
	assert.equal(plans, 3);
});

test("revision triggers cover every application table and every mutation kind", async () => {
	const { results } = await binding
		.prepare(
			"SELECT name, tbl_name FROM sqlite_master WHERE type = 'trigger' AND name LIKE 'cap_revision_%'",
		)
		.all<{ name: string; tbl_name: string }>();
	assert.equal(results.length, 49 * 3);
	assert.equal(new Set(results.map((row) => row.tbl_name)).size, 49);
	const getRevision = () =>
		binding
			.prepare("SELECT revision FROM cap_database_revision WHERE id = 1")
			.first<number>("revision");
	const start = await getRevision();
	assert.equal(typeof start, "number");
	await database.insert(mediaProcessingBudgets).values(budget("revision"));
	await database
		.update(mediaProcessingBudgets)
		.set({ reservedBytes: 1 })
		.where(eq(mediaProcessingBudgets.id, "revision"));
	await database
		.delete(mediaProcessingBudgets)
		.where(eq(mediaProcessingBudgets.id, "revision"));
	assert.equal(await getRevision(), (start ?? 0) + 3);
});

test("a writer between validation and commit aborts the stale batch", async () => {
	await database.insert(mediaProcessingBudgets).values(budget("commit-race"));
	let injected = false;
	let attempts = 0;
	const racing = createCloudflareDb(
		createD1BridgeBinding({
			fetch: async (request) => {
				const body = await request.clone().text();
				if (
					!injected &&
					body.includes('insert into \\"cap_snapshot_guard\\"')
				) {
					injected = true;
					await binding
						.prepare(
							"UPDATE media_processing_budgets SET reserved_bytes = 11 WHERE id = ?",
						)
						.bind("commit-race")
						.run();
				}
				return handleD1BridgeRequest(request, binding);
			},
		}),
	);
	const result = await atomic(racing, async (snapshot) => {
		attempts++;
		const [row] = await snapshot.read((reader) =>
			reader
				.select()
				.from(mediaProcessingBudgets)
				.where(eq(mediaProcessingBudgets.id, "commit-race")),
		);
		assert.ok(row);
		return {
			statements: [
				racing
					.update(mediaProcessingBudgets)
					.set({ reservedBytes: row.reservedBytes + 1 })
					.where(eq(mediaProcessingBudgets.id, "commit-race")),
			],
			result: row.reservedBytes + 1,
		};
	});
	assert.equal(injected, true);
	assert.equal(attempts, 2);
	assert.equal(result, 12);
});

test("an ambiguous transport failure after commit is never replayed", async () => {
	await database
		.insert(mediaProcessingBudgets)
		.values(budget("unknown-outcome"));
	let attempts = 0;
	const failing = createCloudflareDb(
		createD1BridgeBinding({
			fetch: async (request) => {
				const body = await request.clone().text();
				const response = await handleD1BridgeRequest(request, binding);
				if (body.includes('insert into \\"cap_snapshot_guard\\"'))
					throw new Error("Response lost after commit");
				return response;
			},
		}),
	);
	await assert.rejects(
		atomic(failing, async () => {
			attempts++;
			return {
				statements: [
					failing
						.update(mediaProcessingBudgets)
						.set({ reservedBytes: 1 })
						.where(eq(mediaProcessingBudgets.id, "unknown-outcome")),
				],
				result: true,
			};
		}),
		/Response lost after commit/,
	);
	assert.equal(attempts, 1);
	const [row] = await database
		.select()
		.from(mediaProcessingBudgets)
		.where(eq(mediaProcessingBudgets.id, "unknown-outcome"));
	assert.equal(row?.reservedBytes, 1);
});

test("mutation counts exclude revision triggers and preserve zero row claims", async () => {
	await database.insert(mediaProcessingBudgets).values(budget("counts"));
	const results = await database.batch([
		database
			.update(mediaProcessingBudgets)
			.set({ reservedBytes: 1 })
			.where(eq(mediaProcessingBudgets.id, "counts")),
		database
			.update(mediaProcessingBudgets)
			.set({ reservedBytes: 1 })
			.where(eq(mediaProcessingBudgets.id, "missing-budget")),
	]);
	assert.deepEqual(
		results.map((result) => result.meta.changes),
		[1, 0],
	);
});

test("bridge validates input, rejects unsupported methods, and exposes no GET SQL endpoint", async () => {
	assert.equal(
		(
			await handleD1BridgeRequest(
				new Request("http://cap.database/query"),
				binding,
			)
		).status,
		405,
	);
	assert.equal(
		(
			await handleD1BridgeRequest(
				new Request("http://cap.database/query", {
					method: "POST",
					body: JSON.stringify({ operation: "exec", sql: "SELECT 1" }),
				}),
				binding,
			)
		).status,
		400,
	);
	assert.equal(
		(
			await handleD1BridgeRequest(
				new Request("http://cap.database/query", {
					method: "POST",
					body: JSON.stringify({
						operation: "statement",
						method: "run",
						statement: { sql: "SELECT ?", params: [{}] },
					}),
				}),
				binding,
			)
		).status,
		400,
	);
});

test("canonical identity equates Unicode case/composition and IDNA domains without accent folding", () => {
	assert.equal(
		normalizeEmail(" E\u0301QUIPE@BÜCHER.example "),
		normalizeEmail("équipe@xn--bcher-kva.example"),
	);
	assert.notEqual(
		normalizeEmail("équipe@example.com"),
		normalizeEmail("equipe@example.com"),
	);
	assert.throws(() => normalizeEmail("one\u200btwo@example.com"));
	assert.throws(() => normalizeEmail("person@example.com,other@example.com"));
	for (const domain of [
		"example.com/path",
		"example.com?query",
		"example.com#fragment",
		"example.com:443",
		"exam\u200bple.com",
	])
		assert.throws(() => normalizeEmail(`person@${domain}`));
	assert.throws(() => normalizeEmail(`${"é".repeat(33)}@example.com`));
});

test("expired and revoked invitations cannot activate provisioned accounts; tombstoned organizations deny members", async () => {
	const policy = {
		ownerEmail: "access-owner@example.com",
		inviteOnly: true as const,
	};
	const owner = await createCloudflareUser(
		database,
		{ email: policy.ownerEmail, emailVerified: new Date() },
		policy,
	);
	const invited = await provisionCloudflareInvitee(database, {
		organizationId: owner.activeOrganizationId,
		invitedByUserId: owner.id,
		email: "access-member@example.com",
		role: "member",
	});
	assert.ok(invited.inviteId);
	await database
		.update(organizationInvites)
		.set({ expiresAt: new Date(0) })
		.where(eq(organizationInvites.id, invited.inviteId));
	assert.equal(
		await canSignInCloudflare(database, "access-member@example.com", policy),
		false,
	);
	await assert.rejects(
		createCloudflareUser(
			database,
			{ email: "access-member@example.com", emailVerified: new Date() },
			policy,
		),
		/invitation is required/,
	);
	await database
		.update(organizationInvites)
		.set({ expiresAt: new Date("2030-01-01"), status: "declined" })
		.where(eq(organizationInvites.id, invited.inviteId));
	assert.equal(
		await canSignInCloudflare(database, "access-member@example.com", policy),
		false,
	);
	await database
		.update(organizationInvites)
		.set({ status: "pending" })
		.where(eq(organizationInvites.id, invited.inviteId));
	assert.equal(
		await canSignInCloudflare(database, "access-member@example.com", policy),
		true,
	);
	await createCloudflareUser(
		database,
		{ email: "access-member@example.com", emailVerified: new Date() },
		policy,
	);
	await database
		.delete(organizationInvites)
		.where(eq(organizationInvites.id, invited.inviteId));
	assert.equal(
		await canSignInCloudflare(database, "access-member@example.com", policy),
		true,
	);
	await database
		.update(organizations)
		.set({ tombstoneAt: new Date() })
		.where(eq(organizations.id, owner.activeOrganizationId));
	assert.equal(
		await canSignInCloudflare(database, "access-member@example.com", policy),
		false,
	);
});

test("verification tokens are single use under concurrent redemption and wrong guesses consume the exact token", async () => {
	const adapter = DrizzleAdapter(database);
	assert.ok(adapter.createVerificationToken);
	assert.ok(adapter.useVerificationToken);
	await adapter.createVerificationToken({
		identifier: "Token@EXAMPLE.COM",
		token: "token-one",
		expires: new Date("2030-01-01"),
	});
	const redeem = adapter.useVerificationToken;
	const results = await Promise.all(
		Array.from({ length: 5 }, () =>
			redeem({ identifier: "token@example.com", token: "token-one" }),
		),
	);
	assert.equal(results.filter(Boolean).length, 1);
	await adapter.createVerificationToken({
		identifier: "token@example.com",
		token: "token-two",
		expires: new Date("2030-01-01"),
	});
	assert.equal(
		await redeem({ identifier: "token@example.com", token: "wrong" }),
		null,
	);
	assert.equal(
		await redeem({ identifier: "token@example.com", token: "token-two" }),
		null,
	);
});

test("owner bootstrap and concurrent invitations produce one canonical user and membership", async () => {
	const policy = { ownerEmail: "owner@example.com", inviteOnly: true as const };
	await assert.rejects(
		createCloudflareUser(
			database,
			{ email: "stranger@example.com", emailVerified: null },
			policy,
		),
		/invitation is required/,
	);
	const owners = await Promise.all(
		Array.from({ length: 4 }, () =>
			createCloudflareUser(
				database,
				{ email: "OWNER@EXAMPLE.COM", emailVerified: new Date() },
				policy,
			),
		),
	);
	const owner = owners[0];
	assert.ok(owner);
	assert.equal(new Set(owners.map((user) => user.id)).size, 1);
	const inviteResults = await Promise.all(
		Array.from({ length: 4 }, () =>
			provisionCloudflareInvitee(database, {
				organizationId: owner.activeOrganizationId,
				invitedByUserId: owner.id,
				email: "Me\u0301mber@example.com",
				role: "member",
			}),
		),
	);
	assert.equal(new Set(inviteResults.map((result) => result.userId)).size, 1);
	const invitee = inviteResults[0];
	assert.ok(invitee);
	const members = await database
		.select()
		.from(organizationMembers)
		.where(eq(organizationMembers.userId, invitee.userId));
	assert.equal(members.length, 1);
	const matches = await database
		.select()
		.from(users)
		.where(eq(users.email, normalizeEmail("MÉMBER@EXAMPLE.COM")));
	assert.equal(matches.length, 1);
	assert.equal(
		await canSignInCloudflare(database, "MÉMBER@EXAMPLE.COM", policy),
		true,
	);
	assert.equal(
		await canSignInCloudflare(database, "another@example.com", policy),
		false,
	);
});

test("organization deletion fences jobs before cleanup and atomically repairs user pointers", async () => {
	const owner = await createCloudflareUser(
		database,
		{ email: "deletion-owner@example.com", emailVerified: new Date() },
		{ ownerEmail: "deletion-owner@example.com", inviteOnly: true },
	);
	const id = owner.activeOrganizationId;
	const fallback = "fallback-org" as typeof organizations.$inferInsert.id;
	const videoId = "deletion-video" as typeof videos.$inferInsert.id;
	await database.insert(organizations).values({
		id: fallback,
		ownerId: owner.id,
		name: "Remaining organization",
	});
	await database.insert(videos).values({
		id: videoId,
		ownerId: owner.id,
		orgId: id,
		name: "Recording",
		source: { type: "desktopMP4" },
	});
	await database.insert(videoProcessingJobs).values({
		videoId,
		ownerId: owner.id,
		generation: "old-generation",
		state: "processing",
		attemptId: "old-attempt",
		leaseExpiresAt: new Date("2030-01-01"),
		nextRetryAt: new Date(),
	});
	await assert.rejects(
		beginOrganizationDeletion(
			database,
			id,
			"wrong-owner" as typeof users.$inferInsert.id,
		),
		/owner changed/,
	);
	await beginOrganizationDeletion(database, id, owner.id);
	const [job] = await database
		.select()
		.from(videoProcessingJobs)
		.where(eq(videoProcessingJobs.videoId, videoId));
	assert.equal(job?.state, "source-blocked");
	assert.equal(job?.attemptId, null);
	assert.notEqual(job?.generation, "old-generation");
	await assert.rejects(
		atomic(database, async (snapshot) => {
			await requireActiveOrganization(snapshot, id);
			return { statements: [], result: true };
		}),
		/being deleted/,
	);
	await finishOrganizationDeletion(database, id, owner.id);
	assert.equal(
		(
			await database
				.select()
				.from(organizations)
				.where(eq(organizations.id, id))
		).length,
		0,
	);
	assert.equal(
		(await database.select().from(videos).where(eq(videos.id, videoId))).length,
		0,
	);
	assert.equal(
		(
			await database
				.select()
				.from(videoProcessingJobs)
				.where(eq(videoProcessingJobs.videoId, videoId))
		).length,
		0,
	);
	const [updated] = await database
		.select()
		.from(users)
		.where(eq(users.id, owner.id));
	assert.equal(updated?.activeOrganizationId, fallback);
	assert.equal(updated?.defaultOrgId, fallback);
});
