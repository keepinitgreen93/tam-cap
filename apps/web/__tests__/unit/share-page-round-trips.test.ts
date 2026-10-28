import { createHash } from "node:crypto";
import { createCloudflareDb } from "@cap/database/cloudflare";
import {
	createD1BridgeBinding,
	handleD1BridgeRequest,
} from "@cap/database/cloudflare/bridge";
import * as Db from "@cap/database/cloudflare/schema";
import {
	type ImageUpload,
	Organisation,
	Space,
	User,
	Video,
} from "@cap/web-domain";
import { eq } from "drizzle-orm";
import { Context, Effect } from "effect";
import { type ComponentProps, isValidElement, type ReactElement } from "react";
import {
	afterAll,
	beforeAll,
	beforeEach,
	describe,
	expect,
	it,
	vi,
} from "vitest";
import { createTestDatabase } from "../../../../packages/database/cloudflare/test-runtime";

const mocks = vi.hoisted(() => ({
	query: vi.fn<(request: Request) => Promise<Response>>(),
	database: undefined as ReturnType<typeof createCloudflareDb> | undefined,
}));

vi.mock("server-only", () => ({}));
vi.mock("@cap/database/cloudflare/application", () => ({
	db: () => {
		if (!mocks.database) throw new Error("Fixture missing");
		return mocks.database;
	},
}));

vi.mock("@cap/database/auth/session", () => ({
	getCurrentUser: async () => ({ id: "viewer", activeOrganizationId: "org-1" }),
}));
vi.mock("@cap/env", () => ({
	buildEnv: { NEXT_PUBLIC_WEB_URL: "https://cap.so" },
	serverEnv: () => ({}),
}));
vi.mock("@cap/ui", () => ({ Logo: () => null }));
vi.mock("@cap/utils", () => ({ userIsPro: () => true }));
vi.mock("@cap/web-backend", async () => {
	const { Context, Effect } = await import("effect");
	const { resolveEffectiveVideoRules } = await import(
		"../../../../packages/web-backend/src/Videos/EffectiveVideoRules"
	);
	return {
		CloudflareDatabase: Context.GenericTag("SharePerfDatabase"),
		ImageUploads: Context.GenericTag("SharePerfImages"),
		Videos: Context.GenericTag("SharePerfVideos"),
		Analytics: Context.GenericTag("SharePerfAnalytics"),
		provideOptionalAuth: <A, E, R>(effect: Effect.Effect<A, E, R>) => effect,
		resolveEffectiveVideoRules,
	};
});
vi.mock("@cap/web-backend/src/Videos/VideosPolicy", () => ({
	VideosPolicy: Context.GenericTag("SharePerfPolicy"),
}));
vi.mock("@/lib/server", async () => {
	const { db } = await import("@cap/database/cloudflare/application");
	return {
		runPromise: <A, E>(effect: Effect.Effect<A, E, unknown>) =>
			effect.pipe(
				Effect.provideService(Context.GenericTag("SharePerfPolicy"), {
					canViewLoaded: () => Effect.void,
				}),
				Effect.provideService(Context.GenericTag("SharePerfDatabase"), {
					use: <T>(callback: (client: ReturnType<typeof db>) => Promise<T>) =>
						Effect.promise(() => callback(db())),
				}),
				Effect.provideService(Context.GenericTag("SharePerfImages"), {
					resolveImageUrl: (url: string) => Effect.succeed(url),
				}),
				Effect.provideService(Context.GenericTag("SharePerfAnalytics"), {
					countViews: () => Effect.succeed([{ views: 120 }]),
				}),
				Effect.runPromise,
			),
	};
});
vi.mock("next/headers", () => ({ headers: async () => new Headers() }));
vi.mock("next/navigation", () => ({ notFound: vi.fn() }));
vi.mock("@/lib/ai/provider", () => ({ isAiConfigured: () => false }));
vi.mock("@/lib/desktop-segments-recovery", () => ({
	completeDesktopSegmentsManifestAndQueue: vi.fn(),
}));
vi.mock("@/lib/Notification", () => ({
	createNotification: async () => undefined,
}));
vi.mock("@/lib/loom-deferred-processing", () => ({
	getPendingLoomProcessing: () => null,
}));
vi.mock("@/lib/public-share-video", () => ({ getPublicShareVideo: vi.fn() }));
vi.mock("@/lib/share-playback", () => ({
	canStartPlaybackInHtml: () => true,
	getSharePlaybackSource: async () => ({
		url: "https://media.example.com/result.mp4",
		defaultStorage: true,
	}),
}));
vi.mock("@/lib/share-web-url", () => ({ resolveShareWebUrl: vi.fn() }));
vi.mock("@/lib/transcribe", () => ({ transcribeVideo: vi.fn() }));
vi.mock("@/utils/flags", () => ({ isAiGenerationEnabled: async () => true }));
vi.mock("@/app/s/[videoId]/_components/PasswordGate", () => ({
	PasswordGate: () => null,
}));
vi.mock("@/app/s/[videoId]/_components/PendingRecordingShare", () => ({
	PendingRecordingShare: () => null,
}));
vi.mock("@/app/s/[videoId]/_components/ShareHeader", () => ({
	ShareHeader: () => null,
}));
vi.mock("@/app/s/[videoId]/Share", () => ({ Share: () => null }));

import type { ShareHeader } from "@/app/s/[videoId]/_components/ShareHeader";
import ShareVideoPage from "@/app/s/[videoId]/page";
import type { Share } from "@/app/s/[videoId]/Share";

const createdAt = new Date("2026-10-20T12:00:00Z");
const recording = { id: Video.VideoId.make("video-1") };
let runtime: Awaited<ReturnType<typeof createTestDatabase>>;
beforeAll(async () => {
	runtime = await createTestDatabase();
	const viewer = User.UserId.make("viewer"),
		owner = User.UserId.make("owner");
	const orgId = Organisation.OrganisationId.make("org-1"),
		sharedOrg = Organisation.OrganisationId.make("shared-org");
	await runtime.database.insert(Db.users).values([
		{
			id: viewer,
			email: "viewer@share-perf.test",
			name: "Viewer",
			activeOrganizationId: orgId,
			emailVerified: createdAt,
		},
		{
			id: owner,
			email: "owner@share-perf.test",
			name: "Owner",
			activeOrganizationId: orgId,
			emailVerified: createdAt,
		},
		...Array.from({ length: 5 }, (_, index) => ({
			id: User.UserId.make(`author-${index}`),
			email: `author-${index}@share-perf.test`,
			name: `Reviewer ${index}`,
			activeOrganizationId: orgId,
			image: "https://example.com/avatar.png" as ImageUpload.ImageUrlOrKey,
			emailVerified: createdAt,
		})),
	]);
	await runtime.database.insert(Db.organizations).values([
		{ id: orgId, ownerId: viewer, name: "Team", settings: {} },
		{ id: sharedOrg, ownerId: owner, name: "Shared team", settings: {} },
	]);
	await runtime.database.insert(Db.organizationMembers).values({
		id: "shared-member",
		organizationId: sharedOrg,
		userId: viewer,
		role: "member",
	});
	await runtime.database.insert(Db.videos).values({
		id: recording.id,
		name: "Ten minute walkthrough",
		ownerId: owner,
		orgId,
		createdAt,
		updatedAt: createdAt,
		source: { type: "desktopMP4" },
		metadata: { summary: "Project walkthrough" },
		duration: 600,
		public: true,
		isScreenshot: false,
		transcriptionStatus: "COMPLETE",
	});
	await runtime.database.insert(Db.spaces).values(
		Array.from({ length: 3 }, (_, index) => ({
			id: Space.SpaceId.make(index === 0 ? "space-1" : `dash-space-${index}`),
			organizationId: orgId,
			createdById: viewer,
			name: index === 0 ? "Project" : `Space ${index}`,
			privacy: "Public" as const,
			settings: {},
		})),
	);
	await runtime.database.insert(Db.spaceMembers).values({
		id: "space-member",
		spaceId: Space.SpaceId.make("space-1"),
		userId: viewer,
		role: "member",
	});
	await runtime.database.insert(Db.spaceVideos).values({
		id: "share-space",
		addedById: owner,
		videoId: recording.id,
		spaceId: Space.SpaceId.make("space-1"),
	});
	await runtime.database.insert(Db.sharedVideos).values({
		id: "share-org",
		sharedByUserId: owner,
		videoId: recording.id,
		organizationId: sharedOrg,
	});
	for (let offset = 0; offset < 30; offset += 5)
		await runtime.database.insert(Db.comments).values(
			Array.from({ length: 5 }, (_, local) => {
				const index = offset + local;
				return {
					id: `comment-${index}` as typeof Db.comments.$inferSelect.id,
					videoId: recording.id,
					authorId: User.UserId.make(`author-${index % 5}`),
					content: `Review note ${index}`,
					type: "text" as const,
					timestamp: index * 20,
					createdAt,
					updatedAt: createdAt,
				};
			}),
		);
	mocks.database = createCloudflareDb(
		createD1BridgeBinding({ fetch: (request) => mocks.query(request) }),
	);
}, 120000);
afterAll(async () => runtime?.dispose());

async function loadPage() {
	const page = (await ShareVideoPage({
		params: Promise.resolve({ videoId: recording.id }),
		searchParams: Promise.resolve({}),
	})) as ReactElement<{ children: unknown }>;
	const authorized = page.props.children;
	if (!isValidElement(authorized) || typeof authorized.type !== "function") {
		throw new Error("Expected authorized content");
	}
	const content = await (
		authorized.type as (
			props: unknown,
		) => Promise<
			ReactElement<{ children: ReactElement<ComponentProps<typeof Share>> }>
		>
	)(authorized.props);
	const props = content.props.children.props;
	const { header, comments, views, initialPlaybackUrl, ...data } = props;
	const headerElement = header as ReactElement<
		ComponentProps<typeof ShareHeader>
	>;
	return {
		...data,
		header: { ...headerElement.props, views: await headerElement.props.views },
		comments: await comments,
		views: await views,
		initialPlaybackUrl: await initialPlaybackUrl,
	};
}

beforeEach(async () => {
	mocks.query
		.mockReset()
		.mockImplementation((request) =>
			handleD1BridgeRequest(request, runtime.binding),
		);
	await runtime.database
		.delete(Db.videoEdits)
		.where(eq(Db.videoEdits.videoId, recording.id));
	await runtime.database
		.delete(Db.organizationMembers)
		.where(eq(Db.organizationMembers.id, "shared-member"));
	await runtime.database.insert(Db.organizationMembers).values({
		id: "shared-member",
		organizationId: Organisation.OrganisationId.make("shared-org"),
		userId: User.UserId.make("viewer"),
		role: "member",
	});
	await runtime.database
		.delete(Db.spaceMembers)
		.where(eq(Db.spaceMembers.id, "space-member"));
	await runtime.database.insert(Db.spaceMembers).values({
		id: "space-member",
		spaceId: Space.SpaceId.make("space-1"),
		userId: User.UserId.make("viewer"),
		role: "member",
	});
});

describe("share page database round trips", () => {
	it("keeps download permission and edit checks within the existing page load", async () => {
		const pending: Array<() => Promise<void>> = [];
		mocks.query.mockImplementation(
			(request: Request) =>
				new Promise((resolve, reject) => {
					pending.push(async () => {
						try {
							resolve(await handleD1BridgeRequest(request, runtime.binding));
						} catch (error) {
							reject(error);
						}
					});
				}),
		);
		let settled = false;
		const page = loadPage();
		void page.then(
			() => {
				settled = true;
			},
			() => {
				settled = true;
			},
		);
		let roundTrips = 0;
		let idleTicks = 0;
		while (!settled) {
			const issued = mocks.query.mock.calls.length;
			await new Promise((resolve) => setTimeout(resolve, 0));
			if (mocks.query.mock.calls.length !== issued || pending.length === 0) {
				idleTicks = 0;
				continue;
			}
			if (++idleTicks < 3) continue;
			idleTicks = 0;
			roundTrips++;
			await Promise.all(pending.splice(0).map((release) => release()));
		}
		const result = await page;
		expect(result.comments).toHaveLength(30);
		expect(result.data).toMatchObject({ duration: 600 });
		expect(result.header.spacesData).toHaveLength(4);
		expect(result.header).toMatchObject({ canDownload: true, hasEdits: false });
		expect({ roundTrips, queries: mocks.query.mock.calls.length }).toEqual({
			roundTrips: 4,
			queries: 20,
		});
	});

	it.each([false, true])(
		"reads edit metadata only when current native download grants allow it: %s",
		async (canDownload) => {
			if (!canDownload) {
				await runtime.database
					.delete(Db.organizationMembers)
					.where(eq(Db.organizationMembers.id, "shared-member"));
				await runtime.database
					.delete(Db.spaceMembers)
					.where(eq(Db.spaceMembers.id, "space-member"));
			}
			await runtime.database.insert(Db.videoEdits).values({
				videoId: recording.id,
				sourceKey: `owner/${recording.id}/source/original.mp4`,
				editSpec: {
					version: 1,
					sourceDuration: 600,
					keepRanges: [{ start: 0, end: 300 }],
				},
			});
			const result = await loadPage();
			expect(result.comments).toHaveLength(30);
			expect(result.data).toMatchObject({ duration: 600 });
			expect(result.header.spacesData).toHaveLength(4);
			expect(result.header).toMatchObject({
				canDownload,
				hasEdits: canDownload,
			});
			expect(mocks.query.mock.calls).toHaveLength(canDownload ? 20 : 19);
		},
	);

	it.skipIf(!process.env.CAP_SHARE_PAGE_BENCH)(
		"measures simulated 20ms database latency",
		async () => {
			const samples: number[] = [];
			const outputs = new Set<string>();
			mocks.query.mockImplementation(async (request: Request) => {
				await new Promise((resolve) => setTimeout(resolve, 20));
				return handleD1BridgeRequest(request, runtime.binding);
			});
			for (let iteration = 0; iteration < 22; iteration++) {
				const start = performance.now();
				const result = await loadPage();
				if (iteration > 0) samples.push(performance.now() - start);
				outputs.add(
					createHash("sha256").update(JSON.stringify(result)).digest("hex"),
				);
			}
			samples.sort((a, b) => a - b);
			expect(outputs.size).toBe(1);
			console.log(
				JSON.stringify({
					medianMs: samples[10],
					queriesPerLoad: mocks.query.mock.calls.length / 22,
					output: [...outputs][0],
				}),
			);
		},
	);
});
