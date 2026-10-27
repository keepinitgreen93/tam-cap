import { createCloudflareDb } from "@cap/database/cloudflare";
import {
	createD1BridgeBinding,
	handleD1BridgeRequest,
} from "@cap/database/cloudflare/bridge";
import * as Db from "@cap/database/cloudflare/schema";
import { Organisation, User, Video } from "@cap/web-domain";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, expect, it } from "vitest";
import { getDesktopRecordingOutputKey } from "@/lib/desktop-recording-source";
import { getMediaMultipartVideo } from "@/lib/media-multipart-context";
import { createTestDatabase } from "../../../../packages/database/cloudflare/test-runtime";

let runtime: Awaited<ReturnType<typeof createTestDatabase>>;
let beforeBatch: (() => Promise<void>) | undefined;
let database: ReturnType<typeof createCloudflareDb>;
let sequence = 0;
beforeAll(async () => {
	runtime = await createTestDatabase();
	database = createCloudflareDb(
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
	const suffix = String(++sequence);
	const ownerId = User.UserId.make(`mpowner${suffix}`);
	const orgId = Organisation.OrganisationId.make(`mporg${suffix}`);
	const videoId = Video.VideoId.make(`mpvideo${suffix}`);
	await runtime.database
		.insert(Db.users)
		.values({
			id: ownerId,
			email: `multipart${suffix}@test.invalid`,
			activeOrganizationId: orgId,
		});
	await runtime.database
		.insert(Db.organizations)
		.values({ id: orgId, ownerId, name: "Multipart" });
	await runtime.database.insert(Db.videos).values({
		id: videoId,
		ownerId,
		orgId,
		name: "Recording",
		source: { type: "desktopSegments" },
	});
	await runtime.database.insert(Db.videoProcessingJobs).values({
		videoId,
		ownerId,
		generation: "generation",
		attemptId: "attempt",
		state: "processing",
		nextRetryAt: new Date(),
		leaseExpiresAt: new Date(Date.now() + 60000),
		source: {
			version: 1,
			kind: "segments",
			manifestSha256: "a".repeat(64),
			inventorySha256: "b".repeat(64),
			inventoryKey: `${ownerId}/${videoId}/.recording/sources/generation/snapshot/inventory.json`,
			requiredAudio: true,
		},
	});
	return {
		ownerId,
		orgId,
		videoId,
		payload: {
			videoId,
			generation: "generation",
			attemptId: "attempt",
			key: getDesktopRecordingOutputKey(
				ownerId,
				videoId,
				"generation",
				"attempt",
			),
			uploadId: "upload",
		},
	};
}

it("authorizes a current attempt and rejects a canonical legacy overwrite", async () => {
	const f = await fixture();
	expect(await getMediaMultipartVideo(database, f.payload)).toMatchObject({
		fenced: true,
		loom: false,
	});
	expect(
		await getMediaMultipartVideo(database, {
			...f.payload,
			generation: undefined,
			attemptId: undefined,
			key: `${f.ownerId}/${f.videoId}/result.mp4`,
		}),
	).toMatchObject({ status: 409 });
});

it.each(["lease", "organization", "owner", "deletion"] as const)(
	"rechecks a concurrent %s change before issuing a storage capability",
	async (change) => {
		const f = await fixture();
		beforeBatch = async () => {
			if (change === "lease")
				await runtime.database
					.update(Db.videoProcessingJobs)
					.set({ attemptId: "replacement" })
					.where(eq(Db.videoProcessingJobs.videoId, f.videoId));
			if (change === "organization")
				await runtime.database
					.update(Db.organizations)
					.set({ tombstoneAt: new Date() })
					.where(eq(Db.organizations.id, f.orgId));
			if (change === "owner")
				await runtime.database
					.update(Db.videos)
					.set({ ownerId: User.UserId.make("otherowner") })
					.where(eq(Db.videos.id, f.videoId));
			if (change === "deletion")
				await runtime.database
					.update(Db.videoProcessingJobs)
					.set({ errorCode: "video-deleting" })
					.where(eq(Db.videoProcessingJobs.videoId, f.videoId));
		};
		expect(await getMediaMultipartVideo(database, f.payload)).toMatchObject({
			status: 409,
		});
	},
);

it("permits aborting an expired immutable attempt while refusing signing", async () => {
	const f = await fixture();
	await runtime.database
		.update(Db.videoProcessingJobs)
		.set({ attemptId: "replacement", leaseExpiresAt: new Date(0) })
		.where(eq(Db.videoProcessingJobs.videoId, f.videoId));
	expect(await getMediaMultipartVideo(database, f.payload, true)).toMatchObject(
		{ fenced: true },
	);
	expect(await getMediaMultipartVideo(database, f.payload)).toMatchObject({
		status: 409,
	});
});
