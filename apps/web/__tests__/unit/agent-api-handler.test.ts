import { createHash } from "node:crypto";
import {
	agentApiKeys,
	developerApps,
	developerCreditAccounts,
	folders,
	organizations,
	videos,
} from "@cap/database/cloudflare/schema";
import { nanoId } from "@cap/database/helpers";
import { Folder, Video } from "@cap/web-domain";
import { eq } from "drizzle-orm";
import { createTestDatabase } from "../../../../packages/database/cloudflare/test-runtime";
import { createTestOwner } from "../helpers/cloudflare-team";

let fixture: Awaited<ReturnType<typeof createTestDatabase>>;
let owner: Awaited<ReturnType<typeof createTestOwner>>;
const token = `cap_cli_${"x".repeat(43)}`;
const transcriptObjects = vi.hoisted(() => new Map<string, string>());
vi.mock("@/lib/storage-transcript-store", () => ({
	createTranscriptStore: () => ({
		getText: async (key: string) => transcriptObjects.get(key) ?? null,
		put: async (key: string, value: string) => {
			transcriptObjects.set(key, value);
		},
		delete: async (key: string) => {
			transcriptObjects.delete(key);
		},
	}),
}));
vi.mock("@cap/database/cloudflare/application", () => ({
	db: () => fixture.database,
}));

import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
const isRateLimited = vi.hoisted(() => vi.fn(async () => false));
vi.mock("@/lib/rate-limit", () => ({
	isRateLimited,
	RATE_LIMIT_IDS: {
		AGENT_TOKEN_EXCHANGE: "rl_agent_token_exchange",
		AGENT_AUTHORIZATION: "rl_agent_authorization",
		AGENT_UNLOCK: "rl_agent_unlock",
		AGENT_LOOM_IMPORT: "rl_loom_import_per_user",
	},
}));

describe("agent API handler", () => {
	let GET: typeof import("@/app/api/v1/[...route]/route").GET;
	let OPTIONS: typeof import("@/app/api/v1/[...route]/route").OPTIONS;
	let POST: typeof import("@/app/api/v1/[...route]/route").POST;
	let PATCH: typeof import("@/app/api/v1/[...route]/route").PATCH;
	let PUT: typeof import("@/app/api/v1/[...route]/route").PUT;
	let DELETE: typeof import("@/app/api/v1/[...route]/route").DELETE;

	beforeAll(async () => {
		Object.assign(process.env, {
			NEXT_PUBLIC_WEB_URL: "http://localhost",
			WEB_URL: "http://localhost",
			DATABASE_PROVIDER: "d1",
			CAP_RUNTIME: "cloudflare",
			NEXT_PUBLIC_IS_CAP: "false",
			DATABASE_ENCRYPTION_KEY: "01".repeat(32),
			NEXTAUTH_SECRET: "synthetic-test-secret-that-is-long-enough",
			NEXTAUTH_URL: "http://localhost",
			CAP_AWS_BUCKET: "synthetic",
			CAP_AWS_REGION: "us-east-1",
			CAP_AWS_ACCESS_KEY: "synthetic",
			CAP_AWS_SECRET_KEY: "synthetic",
			NODE_ENV: "test",
		});
		fixture = await createTestDatabase();
		owner = await createTestOwner(fixture.database);
		await fixture.database.insert(agentApiKeys).values({
			id: nanoId(),
			userId: owner.id,
			tokenHash: createHash("sha256").update(token).digest("hex"),
			name: "API test",
			scopes: [
				"caps:read",
				"caps:write",
				"profile:read",
				"profile:write",
				"organizations:read",
				"organizations:manage",
				"developer:read",
				"developer:write",
				"developer:secrets",
				"library:write",
				"library:read",
				"billing:write",
			],
			expiresAt: new Date(Date.now() + 3600000),
			lastUsedAt: new Date(),
		});
		const route = await import("@/app/api/v1/[...route]/route");
		GET = route.GET;
		OPTIONS = route.OPTIONS;
		POST = route.POST;
		PATCH = route.PATCH;
		PUT = route.PUT;
		DELETE = route.DELETE;
	}, 120000);
	afterAll(async () => fixture?.dispose());

	const request = (
		path: string,
		method: string,
		payload: unknown,
		key: string,
	) =>
		new Request(`http://localhost/api/v1${path}`, {
			method,
			headers: {
				Authorization: `Bearer ${token}`,
				"Content-Type": "application/json",
				"Idempotency-Key": key,
				"X-Cap-Confirmation": "user",
			},
			body: JSON.stringify(payload),
		});
	it("creates a developer app once under concurrent API retries", async () => {
		const responses = await Promise.all([
			POST(
				request(
					"/developer/apps",
					"POST",
					{ name: "Concurrent app", environment: "development" },
					"create-app-123",
				),
			),
			POST(
				request(
					"/developer/apps",
					"POST",
					{ name: "Concurrent app", environment: "development" },
					"create-app-123",
				),
			),
		]);
		for (const response of responses) expect(response.status).toBe(200);
		const [first, second] = await Promise.all(
			responses.map((response) => response.json()),
		);
		expect(first.appId).toBe(second.appId);
		expect(first.publicKey).toBe(second.publicKey);
		expect(
			await fixture.database
				.select()
				.from(developerApps)
				.where(eq(developerApps.ownerId, owner.id)),
		).toHaveLength(1);
		expect(
			await fixture.database
				.select()
				.from(developerCreditAccounts)
				.where(eq(developerCreditAccounts.ownerId, owner.id)),
		).toHaveLength(1);
	});
	it("returns the projected profile after its atomic update", async () => {
		const response = await PATCH(
			request(
				"/me",
				"PATCH",
				{ name: "Updated owner", lastName: "Verified" },
				"update-profile-123",
			),
		);
		expect(response.status).toBe(200);
		expect(await response.json()).toMatchObject({
			name: "Updated owner",
			lastName: "Verified",
		});
	});
	it("creates an organization without a read-after-write assumption", async () => {
		const response = await POST(
			request(
				"/organizations",
				"POST",
				{ name: "New workspace" },
				"new-workspace-123",
			),
		);
		expect(response.status).toBe(200);
		expect(
			await fixture.database
				.select()
				.from(organizations)
				.where(eq(organizations.name, "New workspace")),
		).toHaveLength(1);
	});
	it("rejects vendor billing operations on self-hosted instances", async () => {
		const response = await POST(
			request(
				`/organizations/${owner.activeOrganizationId}/billing/portal`,
				"POST",
				{},
				"billing-portal-123",
			),
		);
		expect(response.status).toBe(403);
		expect(await response.json()).toMatchObject({ code: "FORBIDDEN" });
	});

	it("rolls back app, keys, and receipt if creating its credit account fails", async () => {
		await fixture.binding
			.prepare(
				"CREATE TRIGGER reject_account BEFORE INSERT ON developer_credit_accounts BEGIN SELECT RAISE(ABORT, 'reject account'); END",
			)
			.run();
		try {
			const response = await POST(
				request(
					"/developer/apps",
					"POST",
					{ name: "Rollback app", environment: "development" },
					"rollback-app-123",
				),
			);
			expect(response.status).toBe(503);
			expect(
				await fixture.database
					.select()
					.from(developerApps)
					.where(eq(developerApps.name, "Rollback app")),
			).toHaveLength(0);
		} finally {
			await fixture.binding.prepare("DROP TRIGGER reject_account").run();
		}
		const response = await POST(
			request(
				"/developer/apps",
				"POST",
				{ name: "Rollback app", environment: "development" },
				"rollback-app-123",
			),
		);
		expect(response.status).toBe(200);
	});
	it("denies mutations of another owner's developer app", async () => {
		const stranger = await createTestOwner(fixture.database);
		const id = nanoId();
		await fixture.database.insert(developerApps).values({
			id,
			ownerId: stranger.id,
			name: "Private app",
			environment: "development",
		});
		const response = await PATCH(
			request(
				`/developer/apps/${id}`,
				"PATCH",
				{ name: "Changed" },
				"foreign-app-123",
			),
		);
		expect(response.status).toBe(404);
		expect(
			(
				await fixture.database
					.select()
					.from(developerApps)
					.where(eq(developerApps.id, id))
			)[0]?.name,
		).toBe("Private app");
	});
	it("deletes more than 100 nested folders in a bounded atomic batch", async () => {
		const rootId = Folder.FolderId.make(nanoId());
		await fixture.database.insert(folders).values({
			id: rootId,
			name: "Parent",
			createdById: owner.id,
			organizationId: owner.activeOrganizationId,
		});
		const children = Array.from({ length: 110 }, () => ({
			id: Folder.FolderId.make(nanoId()),
			name: "Child",
			createdById: owner.id,
			organizationId: owner.activeOrganizationId,
			parentId: rootId,
		}));
		for (let offset = 0; offset < children.length; offset += 5)
			await fixture.database
				.insert(folders)
				.values(children.slice(offset, offset + 5));
		const response = await DELETE(
			request(`/folders/${rootId}`, "DELETE", {}, "delete-tree-123"),
		);
		expect(response.status).toBe(200);
		expect(
			await fixture.database
				.select()
				.from(folders)
				.where(eq(folders.createdById, owner.id)),
		).toHaveLength(0);
	});

	it("patches collection JSON without losing sibling settings", async () => {
		const id = Folder.FolderId.make(nanoId());
		await fixture.database.insert(folders).values({
			id,
			name: "Collection",
			createdById: owner.id,
			organizationId: owner.activeOrganizationId,
			settings: {
				publicPage: { title: "Original", subtitle: "Keep this" },
			},
		});
		const response = await PATCH(
			request(
				`/folders/${id}/public-page`,
				"PATCH",
				{ title: "Changed title" },
				"patch-collection-123",
			),
		);
		expect(response.status).toBe(200);
		expect(
			(
				await fixture.database.select().from(folders).where(eq(folders.id, id))
			)[0]?.settings,
		).toMatchObject({
			publicPage: { title: "Changed title", subtitle: "Keep this" },
		});
		await fixture.database.delete(folders).where(eq(folders.id, id));
	});

	it("publishes one competing transcript revision and replays its receipt", async () => {
		const id = Video.VideoId.make(nanoId());
		await fixture.database.insert(videos).values({
			id,
			ownerId: owner.id,
			orgId: owner.activeOrganizationId,
			name: "Transcript",
			source: { type: "webMP4" },
			duration: 10,
			width: 320,
			height: 180,
			fps: 30,
			transcriptionStatus: "COMPLETE",
		});
		const original = "WEBVTT\n\n00:00:00.000 --> 00:00:01.000\nOriginal\n";
		const originalKey = `${owner.id}/${id}/transcription.vtt`;
		transcriptObjects.set(originalKey, original);
		const expectedRevision = createHash("sha256")
			.update(original)
			.digest("hex");
		const choices = [
			{ expectedRevision, cues: [{ startMs: 0, endMs: 1000, text: "First" }] },
			{ expectedRevision, cues: [{ startMs: 0, endMs: 1000, text: "Second" }] },
		];
		const results = await Promise.all(
			choices.map((payload, index) =>
				PUT(
					request(
						`/caps/${id}/transcript`,
						"PUT",
						payload,
						`transcript-race-${index}`,
					),
				),
			),
		);
		expect(results.map((result) => result.status).sort()).toEqual([200, 409]);
		const winner = results.findIndex((result) => result.status === 200);
		const result = await results[winner]?.json();
		const replay = await PUT(
			request(
				`/caps/${id}/transcript`,
				"PUT",
				choices[winner],
				`transcript-race-${winner}`,
			),
		);
		expect(replay.status).toBe(200);
		expect(await replay.json()).toEqual(result);
		expect(transcriptObjects.get(originalKey)).toBe(original);
		const [video] = await fixture.database
			.select()
			.from(videos)
			.where(eq(videos.id, id));
		expect(video?.metadata?.transcriptPublication?.revision).toBe(
			result.revision,
		);
		const read = await GET(
			new Request(`http://localhost/api/v1/caps/${id}/transcript?format=json`, {
				headers: { Authorization: `Bearer ${token}` },
			}),
		);
		expect(read.status).toBe(200);
		expect((await read.json()).revision).toBe(result.revision);
	});

	it("handles CORS preflight without authentication", async () => {
		const response = await OPTIONS(
			new Request("http://localhost/api/v1/caps", {
				method: "OPTIONS",
				headers: {
					Origin: "http://localhost",
					"Access-Control-Request-Method": "GET",
					"Access-Control-Request-Headers": "x-cap-confirmation",
				},
			}),
		);
		expect(response.status).toBeLessThan(400);
		expect(response.headers.get("access-control-allow-headers")).toContain(
			"X-Cap-Confirmation",
		);
	});

	it("returns the stable authentication error without a credential", async () => {
		for (const path of ["/api/v1/caps", "/api/v1/auth/status"]) {
			const response = await GET(new Request(`http://localhost${path}`));
			const body = await response.json();

			expect(response.status).toBe(401);
			expect(body).toMatchObject({
				_tag: "AgentAuthenticationError",
				code: "AUTH_REQUIRED",
				retryable: false,
				retryAfterMs: null,
			});
			expect(body.requestId).toEqual(expect.any(String));
		}
	});

	it("rate limits unauthenticated authorization-code exchange before database access", async () => {
		isRateLimited.mockResolvedValueOnce(true);
		const response = await POST(
			new Request("http://localhost/api/v1/auth/token", {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({
					code: "c".repeat(43),
					codeVerifier: "v".repeat(43),
					redirectUri: "http://127.0.0.1:49152/callback",
				}),
			}),
		);
		const body = await response.json();
		expect(response.status).toBe(429);
		expect(body).toMatchObject({
			code: "RATE_LIMITED",
			retryable: true,
			retryAfterMs: 60_000,
		});
	});

	it("authenticates unlocks and mutations before executing them", async () => {
		const requests = [
			POST(
				new Request("http://localhost/api/v1/caps/cap_synthetic/unlock", {
					method: "POST",
					headers: { "Content-Type": "text/plain" },
					body: "not-a-real-password",
				}),
			),
			POST(
				new Request("http://localhost/api/v1/caps/cap_synthetic/comments", {
					method: "POST",
					headers: { "Content-Type": "application/json" },
					body: JSON.stringify({ content: "Synthetic comment" }),
				}),
			),
			PATCH(
				new Request("http://localhost/api/v1/caps/cap_synthetic", {
					method: "PATCH",
					headers: { "Content-Type": "application/json" },
					body: JSON.stringify({ title: "Synthetic title" }),
				}),
			),
			PUT(
				new Request("http://localhost/api/v1/caps/cap_synthetic/password", {
					method: "PUT",
					headers: { "Content-Type": "text/plain" },
					body: "not-a-real-password",
				}),
			),
			DELETE(
				new Request("http://localhost/api/v1/caps/cap_synthetic", {
					method: "DELETE",
				}),
			),
			PUT(
				new Request("http://localhost/api/v1/me/image", {
					method: "PUT",
					headers: { "Content-Type": "application/json" },
					body: JSON.stringify({
						data: "c3ludGhldGlj",
						contentType: "image/png",
						fileName: "synthetic.png",
					}),
				}),
			),
			POST(
				new Request("http://localhost/api/v1/me/sign-out-all", {
					method: "POST",
				}),
			),
			POST(
				new Request("http://localhost/api/v1/me/referrals", {
					method: "POST",
				}),
			),
			POST(
				new Request("http://localhost/api/v1/organizations", {
					method: "POST",
					headers: { "Content-Type": "application/json" },
					body: JSON.stringify({ name: "Synthetic organization" }),
				}),
			),
			POST(
				new Request(
					"http://localhost/api/v1/organizations/org_synthetic/billing/checkout",
					{
						method: "POST",
						headers: { "Content-Type": "application/json" },
						body: JSON.stringify({ interval: "yearly" }),
					},
				),
			),
			PUT(
				new Request(
					"http://localhost/api/v1/organizations/org_synthetic/storage/s3",
					{
						method: "PUT",
						headers: { "Content-Type": "application/json" },
						body: JSON.stringify({
							provider: "aws",
							accessKeyId: "synthetic",
							secretAccessKey: "synthetic",
							endpoint: "https://s3.amazonaws.com",
							bucketName: "synthetic",
							region: "us-east-1",
						}),
					},
				),
			),
			POST(
				new Request(
					"http://localhost/api/v1/organizations/org_synthetic/storage/google-drive/connect",
					{ method: "POST" },
				),
			),
			POST(
				new Request(
					"http://localhost/api/v1/developer/apps/app_synthetic/credits/checkout",
					{
						method: "POST",
						headers: { "Content-Type": "application/json" },
						body: JSON.stringify({ amountCents: 1_000 }),
					},
				),
			),
			POST(
				new Request(
					"http://localhost/api/v1/organizations/org_synthetic/imports/loom",
					{
						method: "POST",
						headers: { "Content-Type": "application/json" },
						body: JSON.stringify({
							loomUrl: "https://www.loom.com/share/synthetic",
						}),
					},
				),
			),
			GET(
				new Request(
					"http://localhost/api/v1/developer/apps/app_synthetic/videos",
				),
			),
			GET(
				new Request(
					"http://localhost/api/v1/developer/apps/app_synthetic/transactions",
				),
			),
			DELETE(
				new Request(
					"http://localhost/api/v1/developer/apps/app_synthetic/videos/video_synthetic",
					{ method: "DELETE" },
				),
			),
			PATCH(
				new Request(
					"http://localhost/api/v1/folders/folder_synthetic/public-page",
					{
						method: "PATCH",
						headers: { "Content-Type": "application/json" },
						body: JSON.stringify({ title: "Synthetic collection" }),
					},
				),
			),
			PUT(
				new Request("http://localhost/api/v1/spaces/space_synthetic/logo", {
					method: "PUT",
					headers: { "Content-Type": "application/json" },
					body: JSON.stringify({
						data: "c3ludGhldGlj",
						contentType: "image/png",
						fileName: "synthetic.png",
					}),
				}),
			),
		];
		for (const request of requests) {
			const response = await request;
			const body = await response.json();
			expect(response.status).toBe(401);
			expect(body.code).toBe("AUTH_REQUIRED");
		}
	});
});
