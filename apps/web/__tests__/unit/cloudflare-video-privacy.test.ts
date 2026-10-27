import { createCloudflareDb } from "@cap/database/cloudflare";
import {
	createD1BridgeBinding,
	handleD1BridgeRequest,
} from "@cap/database/cloudflare/bridge";
import * as Db from "@cap/database/cloudflare/schema";
import { Organisation, User, Video } from "@cap/web-domain";
import { eq } from "drizzle-orm";
import { NextRequest } from "next/server";
import { afterAll, afterEach, beforeAll, expect, it, vi } from "vitest";
import { createTestDatabase } from "../../../../packages/database/cloudflare/test-runtime";

const state = vi.hoisted(() => ({
	database: undefined as ReturnType<typeof createCloudflareDb> | undefined,
	user: undefined as
		| { id: User.UserId; stripeSubscriptionStatus: string }
		| undefined,
}));
vi.mock("@cap/database/cloudflare/application", () => ({
	db: () => {
		if (!state.database) throw Error("Missing database");
		return state.database;
	},
}));
vi.mock("@cap/database/auth/session", () => ({
	getCurrentUser: async () => state.user,
}));
vi.mock("@cap/env", () => ({
	buildEnv: { NEXT_PUBLIC_IS_CAP: "true" },
	serverEnv: () => ({ WEB_URL: "https://cap.test" }),
}));

import { updateVideoCallToAction } from "@/actions/videos/call-to-action";
import { updateVideoSettings } from "@/actions/videos/settings";
import { PUT } from "@/app/api/video/metadata/route";
import { ensureRecordingOrganization } from "@/lib/desktop-recording-organization";
import { getPublicShareVideo } from "@/lib/public-share-video";

let runtime: Awaited<ReturnType<typeof createTestDatabase>>;
let beforeBatch: (() => Promise<void>) | undefined;
let sequence = 0;
beforeAll(async () => {
	runtime = await createTestDatabase();
	state.database = createCloudflareDb(
		createD1BridgeBinding({
			fetch: async (request) => {
				const payload = (await request.clone().json()) as { operation: string };
				if (payload.operation === "batch" && beforeBatch) {
					const action = beforeBatch;
					beforeBatch = undefined;
					await action();
				}
				return handleD1BridgeRequest(request, runtime.binding);
			},
		}),
	);
}, 60000);
afterAll(async () => runtime?.dispose());
afterEach(() => {
	vi.unstubAllEnvs();
	beforeBatch = undefined;
});
async function fixture() {
	const suffix = String(++sequence),
		ownerId = User.UserId.make(`powner${suffix}`),
		orgId = Organisation.OrganisationId.make(`porg${suffix}`),
		videoId = Video.VideoId.make(`pvideo${suffix}`);
	await runtime.database.insert(Db.users).values({
		id: ownerId,
		email: `${suffix}@privacy.test`,
		emailVerified: new Date(),
		activeOrganizationId: orgId,
	});
	await runtime.database
		.insert(Db.organizations)
		.values({ id: orgId, ownerId, name: "Privacy" });
	await runtime.database.insert(Db.videos).values({
		id: videoId,
		orgId,
		ownerId,
		public: true,
		source: { type: "webMP4" },
		settings: { disableCaptions: true },
		width: 320,
		height: 180,
		duration: 10,
	});
	state.user = { id: ownerId, stripeSubscriptionStatus: "active" };
	return { ownerId, orgId, videoId };
}
async function metadata(videoId: string, metadata: unknown) {
	return PUT(
		new NextRequest("https://cap.test/api/video/metadata", {
			method: "PUT",
			body: JSON.stringify({ videoId, metadata }),
		}),
	);
}
it("viewer-only grants cannot bootstrap a recording organization", async () => {
	const input = await fixture(),
		guest = User.UserId.make("vieweronly");
	await runtime.database.insert(Db.users).values({
		id: guest,
		email: "viewer@privacy.test",
		emailVerified: new Date(),
		activeOrganizationId: Organisation.OrganisationId.make(""),
	});
	await runtime.database.insert(Db.videoViewerGrants).values({
		id: "viewgrant",
		videoId: input.videoId,
		email: "viewer@privacy.test",
		invitedByUserId: input.ownerId,
	});
	await expect(
		ensureRecordingOrganization(
			runtime.database,
			guest,
			Organisation.OrganisationId.make("deniedorg"),
			"deniedmember",
		),
	).rejects.toThrow("Workspace");
	expect(
		await runtime.database
			.select()
			.from(Db.organizations)
			.where(eq(Db.organizations.ownerId, guest)),
	).toEqual([]);
});
it("concurrent bootstrap owner calls create exactly one fallback organization", async () => {
	vi.stubEnv("CAP_OWNER_EMAIL", "bootstrap@privacy.test");
	const ownerId = User.UserId.make("bootstrap");
	await runtime.database.insert(Db.users).values({
		id: ownerId,
		email: "bootstrap@privacy.test",
		activeOrganizationId: Organisation.OrganisationId.make(""),
	});
	const results = await Promise.all([
		ensureRecordingOrganization(
			runtime.database,
			ownerId,
			Organisation.OrganisationId.make("bootstraporg1"),
			"bootmember1",
		),
		ensureRecordingOrganization(
			runtime.database,
			ownerId,
			Organisation.OrganisationId.make("bootstraporg2"),
			"bootmember2",
		),
	]);
	expect(new Set(results.map((result) => result.id)).size).toBe(1);
	expect(results.filter((result) => result.created)).toHaveLength(1);
	expect(
		await runtime.database
			.select()
			.from(Db.organizations)
			.where(eq(Db.organizations.ownerId, ownerId)),
	).toHaveLength(1);
});
it("concurrent settings and CTA patches preserve independent JSON keys", async () => {
	const { videoId } = await fixture();
	await Promise.all([
		updateVideoSettings(videoId, { disableComments: true }),
		updateVideoCallToAction(videoId, { label: "Visit", url: "example.com" }),
	]);
	const [row] = await runtime.database
		.select()
		.from(Db.videos)
		.where(eq(Db.videos.id, videoId));
	expect(row?.settings).toMatchObject({
		disableCaptions: true,
		disableComments: true,
		callToAction: { label: "Visit", url: "https://example.com/" },
	});
	await updateVideoCallToAction(videoId, null);
	const [removed] = await runtime.database
		.select()
		.from(Db.videos)
		.where(eq(Db.videos.id, videoId));
	expect(removed?.settings).toEqual({
		disableCaptions: true,
		disableComments: true,
	});
});
it("an ownership transfer between planning and commit rejects viewer settings", async () => {
	const { videoId } = await fixture();
	beforeBatch = async () => {
		await runtime.database
			.update(Db.videos)
			.set({ ownerId: User.UserId.make("changedowner") })
			.where(eq(Db.videos.id, videoId));
	};
	await expect(
		updateVideoSettings(videoId, { disableComments: true }),
	).rejects.toThrow();
	const [row] = await runtime.database
		.select()
		.from(Db.videos)
		.where(eq(Db.videos.id, videoId));
	expect(row?.settings).toEqual({ disableCaptions: true });
});
it("public sharing hides private, password, uploading, missing, and tombstoned records", async () => {
	const { videoId, orgId } = await fixture();
	expect(await getPublicShareVideo(videoId)).toMatchObject({
		id: videoId,
		sourceType: "webMP4",
		duration: 10,
	});
	for (const change of [
		{ public: false },
		{ public: true, password: "secret" },
		{ password: null, isScreenshot: true },
	]) {
		await runtime.database
			.update(Db.videos)
			.set(change)
			.where(eq(Db.videos.id, videoId));
		expect(await getPublicShareVideo(videoId)).toBeNull();
	}
	await runtime.database
		.update(Db.videos)
		.set({ isScreenshot: false })
		.where(eq(Db.videos.id, videoId));
	await runtime.database
		.insert(Db.videoUploads)
		.values({ videoId, phase: "uploading" });
	expect(await getPublicShareVideo(videoId)).toBeNull();
	await runtime.database
		.delete(Db.videoUploads)
		.where(eq(Db.videoUploads.videoId, videoId));
	await runtime.database
		.update(Db.organizations)
		.set({ tombstoneAt: new Date() })
		.where(eq(Db.organizations.id, orgId));
	expect(await getPublicShareVideo(videoId)).toBeNull();
	expect(await getPublicShareVideo(Video.VideoId.make("missing"))).toBeNull();
});
it("metadata changes retain transcript and edit fencing state and validate client fields", async () => {
	const { videoId } = await fixture();
	const protectedMetadata = {
		transcriptPublication: {
			version: 1 as const,
			id: crypto.randomUUID(),
			vtt: false,
			edit: false,
			revision: null,
		},
		editTranscriptBackfill: {
			status: "processing" as const,
			requestId: "request",
			requestedAt: new Date().toISOString(),
		},
	};
	await runtime.database
		.update(Db.videos)
		.set({ metadata: protectedMetadata })
		.where(eq(Db.videos.id, videoId));
	expect(
		(
			await metadata(videoId, {
				sourceName: "new.mp4",
				transcriptPublication: null,
				editTranscriptBackfill: null,
			})
		).status,
	).toBe(200);
	const [row] = await runtime.database
		.select()
		.from(Db.videos)
		.where(eq(Db.videos.id, videoId));
	expect(row?.metadata).toEqual({
		...protectedMetadata,
		sourceName: "new.mp4",
	});
	expect(
		(await metadata(videoId, { sourceName: { invalid: true } })).status,
	).toBe(400);
});
it("an organization tombstone races metadata publication without losing the original value", async () => {
	const { videoId, orgId } = await fixture();
	beforeBatch = async () => {
		await runtime.database
			.update(Db.organizations)
			.set({ tombstoneAt: new Date() })
			.where(eq(Db.organizations.id, orgId));
	};
	expect(
		(await metadata(videoId, { sourceName: "must-not-publish" })).status,
	).toBe(401);
	const [row] = await runtime.database
		.select()
		.from(Db.videos)
		.where(eq(Db.videos.id, videoId));
	expect(row?.metadata).toBeNull();
});
