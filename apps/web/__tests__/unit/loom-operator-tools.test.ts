import type { HttpApi } from "@effect/platform";
import type { Layer as EffectLayer } from "effect";
import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({
	rows: [] as { ownerId: string }[],
	pro: true,
	process: vi.fn(),
	operator: vi.fn(),
	backfill: vi.fn(),
}));
vi.mock("server-only", () => ({}));
vi.mock("@cap/database/cloudflare/application", () => ({
	db: () => ({
		select: () => ({
			from: () => ({ where: () => ({ limit: async () => state.rows }) }),
		}),
	}),
}));
vi.mock("@cap/env", () => ({
	serverEnv: () => ({ MEDIA_SERVER_WEBHOOK_SECRET: "synthetic-secret" }),
}));
vi.mock("@/lib/loom-csv-import", () => ({ processLoomCsvRows: state.process }));
vi.mock("@/lib/org-pro", () => ({
	isOrganizationOwnerPro: async () => state.pro,
}));
vi.mock("@/lib/loom-concierge", () => ({
	resolveTrustedMigrationOperator: state.operator,
}));
vi.mock("@/lib/loom-import-backfill", () => ({
	backfillLoomImport: state.backfill,
}));
type ApiLayer = EffectLayer.Layer<HttpApi.Api>;
vi.mock("@/lib/server", async () => {
	const { HttpApiBuilder, HttpServer } = await import("@effect/platform");
	const { Layer } = await import("effect");
	return {
		apiToHandler: (api: ApiLayer) => {
			const { handler } = HttpApiBuilder.toWebHandler(
				Layer.mergeAll(api, HttpServer.layerContext),
			);
			return (request: Request) => handler(request);
		},
	};
});

import { POST as backfill } from "@/app/api/internal/loom-imports/backfill/route";
import { POST as csv } from "@/app/api/internal/loom-imports/csv/route";
import { getOwnerOriginalKey } from "@/lib/loom-original-key";

const org = "orgaaaaaaaaaaaa";
const operatorId = "operatoraaaaaaa";
const videoId = "videoaaaaaaaaaa";
const row = {
	rowNumber: 2,
	loomUrl: "https://www.loom.com/share/abc",
	userEmail: "a@b.co",
};
const call = (
	handler: (request: Request) => Promise<Response>,
	path: string,
	body: unknown,
	secret: string | null = "synthetic-secret",
) =>
	handler(
		new NextRequest(
			`https://synthetic.example/api/internal/loom-imports/${path}`,
			{
				method: "POST",
				headers: {
					"Content-Type": "application/json",
					...(secret ? { "x-media-server-secret": secret } : {}),
				},
				body: JSON.stringify(body),
			},
		),
	);
beforeEach(() => {
	state.rows = [];
	state.pro = true;
	state.process
		.mockReset()
		.mockResolvedValue({
			success: true,
			importedCount: 1,
			failedCount: 0,
			results: [
				{ rowNumber: 2, userEmail: row.userEmail, success: true, videoId },
			],
		});
	state.operator.mockReset().mockResolvedValue({ id: operatorId });
	state.backfill
		.mockReset()
		.mockResolvedValue({ videoId, status: "unchanged", changes: [] });
});
describe("operator CSV HTTP boundary", () => {
	it("requires the configured service secret", async () => {
		expect(
			(await call(csv, "csv", { organizationId: org, rows: [row] }, null))
				.status,
		).toBe(401);
		expect(
			(await call(csv, "csv", { organizationId: org, rows: [row] }, "wrong"))
				.status,
		).toBe(401);
		expect(state.process).not.toHaveBeenCalled();
	});
	it("imports authorized rows as the current workspace owner", async () => {
		state.rows = [{ ownerId: operatorId }];
		const response = await call(csv, "csv", {
			organizationId: org,
			rows: [row],
		});
		expect(response.status).toBe(200);
		expect(await response.json()).toMatchObject({ importedCount: 1 });
		expect(state.process).toHaveBeenCalledWith(
			expect.objectContaining({
				actorId: operatorId,
				orgId: org,
				allowFolders: true,
				importPriority: "bulk",
				rows: [expect.objectContaining(row)],
			}),
		);
	});
	it("rejects missing workspaces and unavailable entitlement", async () => {
		expect(
			(await call(csv, "csv", { organizationId: org, rows: [row] })).status,
		).toBe(404);
		state.rows = [{ ownerId: operatorId }];
		state.pro = false;
		expect(
			(await call(csv, "csv", { organizationId: org, rows: [row] })).status,
		).toBe(403);
		expect(state.process).not.toHaveBeenCalled();
	});
	it("bounds each request at 25 rows", async () => {
		expect(
			(
				await call(csv, "csv", {
					organizationId: org,
					rows: Array.from({ length: 26 }, () => row),
				})
			).status,
		).toBe(400);
	});
});
describe("backfill HTTP operator binding", () => {
	it("checks the secret before resolving operator identity", async () => {
		expect(
			(
				await call(
					backfill,
					"backfill",
					{ organizationId: org, items: [{ videoId }] },
					null,
				)
			).status,
		).toBe(401);
		expect(state.operator).not.toHaveBeenCalled();
		expect(state.backfill).not.toHaveBeenCalled();
	});
	it("passes the trusted configured operator to every mutation", async () => {
		expect(
			(
				await call(backfill, "backfill", {
					organizationId: org,
					items: [{ videoId }],
				})
			).status,
		).toBe(200);
		expect(state.backfill).toHaveBeenCalledExactlyOnceWith(
			org,
			{ videoId },
			operatorId,
		);
	});
	it("fails closed when no verified operator can be resolved", async () => {
		state.operator.mockRejectedValueOnce(new Error("Unauthorized"));
		expect(
			(
				await call(backfill, "backfill", {
					organizationId: org,
					items: [{ videoId }],
				})
			).status,
		).toBe(403);
		expect(state.backfill).not.toHaveBeenCalled();
	});
});
describe("original owner-key mapping", () => {
	it.each([
		["a/vid/raw-upload.webm", "b/vid/raw-upload.webm"],
		["a/vid/nested/file.webm", "b/vid/nested/file.webm"],
		["a/other/raw-upload.webm", null],
		["a/vid/", null],
		[undefined, null],
	])("maps only this recording: %s", (key, expected) => {
		expect(getOwnerOriginalKey(key, "b", "vid")).toBe(expected);
	});
});
