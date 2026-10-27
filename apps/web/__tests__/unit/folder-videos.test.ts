import { CloudflareDatabase as Database, ImageUploads } from "@cap/web-backend";
import { Folder, Organisation, Space } from "@cap/web-domain";
import { Effect } from "effect";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { getVideosByFolderId } from "@/lib/folder";

const mocks = vi.hoisted(() => ({ query: vi.fn() }));

vi.mock("server-only", () => ({}));
vi.mock("@cap/web-backend", async () => {
	const { drizzle } = await import("drizzle-orm/sqlite-proxy");
	const { Effect } = await import("effect");
	const { resolveEffectiveVideoRules } = await import(
		"../../../../packages/web-backend/src/Videos/EffectiveVideoRules"
	);
	const client = drizzle(mocks.query);
	class Database extends Effect.Service<Database>()("Database", {
		succeed: {
			use: <T>(callback: (db: typeof client) => Promise<T>) =>
				Effect.promise(() => callback(client)),
		},
	}) {}
	class ImageUploads extends Effect.Service<ImageUploads>()("ImageUploads", {
		succeed: {
			resolveImageUrl: (key: string) => Effect.succeed(key),
		},
	}) {}
	return {
		CloudflareDatabase: Database,
		ImageUploads,
		resolveEffectiveVideoRules,
	};
});

beforeEach(() => {
	mocks.query.mockResolvedValue({ rows: [] });
});

describe.each([
	{ variant: "user" } as const,
	{ variant: "space", spaceId: Space.SpaceId.make("space-1") } as const,
	{
		variant: "org",
		organizationId: Organisation.OrganisationId.make("org-1"),
	} as const,
])("$variant folder videos", (root) => {
	it.each([125.5, null])(
		"preserves a stored duration of %s",
		async (duration) => {
			mocks.query.mockResolvedValueOnce({
				rows: [
					[
						"video-1",
						"owner-1",
						"Product walkthrough",
						new Date("2026-10-23T12:00:00Z").getTime(),
						1,
						null,
						JSON.stringify({ type: "webMP4" }),
						0,
						duration,
						null,
						"org-1",
						0,
						0,
						"[]",
						"Owner",
						new Date("2026-10-23T12:00:00Z").getTime(),
						0,
						0,
					],
				],
			});
			const videos = await getVideosByFolderId(
				Folder.FolderId.make("folder-1"),
				root,
			).pipe(
				Effect.provide(Database.Default),
				Effect.provide(ImageUploads.Default),
				Effect.runPromise,
			);

			expect(videos).toMatchObject([
				{
					id: "video-1",
					source: { type: "webMP4" },
					duration: duration ?? undefined,
					hasActiveUpload: false,
				},
			]);
		},
	);
});
