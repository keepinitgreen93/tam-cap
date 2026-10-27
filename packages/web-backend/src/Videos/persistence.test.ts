import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { after, before, test } from "node:test";
import { createCloudflareDb } from "@cap/database/cloudflare";
import {
	createD1BridgeBinding,
	handleD1BridgeRequest,
} from "@cap/database/cloudflare/bridge";
import * as Db from "@cap/database/cloudflare/schema";
import {
	DatabaseError,
	Folder,
	Organisation,
	Storage,
	User,
	Video,
} from "@cap/web-domain";
import { and, eq } from "drizzle-orm";
import { Effect, Option } from "effect";
import { Miniflare } from "miniflare";
import { CloudflareDatabase } from "../CloudflareDatabase.ts";
import {
	createFolder,
	deleteFolderTree,
	updateFolder,
} from "../Folders/persistence.ts";
import {
	activeStorageObject,
	writeStorageObject,
} from "../Storage/persistence.ts";
import { StorageRepo } from "../Storage/StorageRepo.ts";
import {
	activeVideo,
	createVideo,
	deleteVideo,
	prepareVideoDeletion,
	updateVideoUploadProgress,
} from "./persistence.ts";

const runtime = new Miniflare({
	modules: true,
	script: "export default { fetch() { return new Response('test'); } }",
	compatibilityDate: "2025-02-04",
	d1Databases: { DB: "cap-video-services-test" },
});
let database: ReturnType<typeof createCloudflareDb>;
let beforeBatch: (() => Promise<void>) | undefined;

const runStorage = <A>(run: (repo: StorageRepo) => Effect.Effect<A, unknown>) =>
	Effect.runPromise(
		Effect.flatMap(StorageRepo, run).pipe(
			Effect.provide(StorageRepo.DefaultWithoutDependencies),
			Effect.provideService(
				CloudflareDatabase,
				CloudflareDatabase.make({
					use: (callback) =>
						Effect.tryPromise({
							try: () => callback(database),
							catch: (cause) => new DatabaseError({ cause }),
						}),
				}),
			),
		),
	);

before(async () => {
	process.env.NEXT_PUBLIC_WEB_URL ??= "http://localhost:3000";
	const binding = await runtime.getD1Database("DB");
	const journal = JSON.parse(
		await readFile(
			new URL(
				"../../../database/cloudflare/migrations/meta/_journal.json",
				import.meta.url,
			),
			"utf8",
		),
	) as { entries: { tag: string }[] };
	for (const { tag } of journal.entries) {
		const migration = await readFile(
			new URL(
				`../../../database/cloudflare/migrations/${tag}.sql`,
				import.meta.url,
			),
			"utf8",
		);
		for (const statement of migration.split("--> statement-breakpoint"))
			if (statement.trim()) await binding.prepare(statement).run();
	}
	database = createCloudflareDb(
		createD1BridgeBinding({
			fetch: async (request) => {
				const incoming = new Request(request);
				const payload = (await incoming.clone().json()) as {
					operation: string;
				};
				if (payload.operation === "batch" && beforeBatch) {
					const hook = beforeBatch;
					beforeBatch = undefined;
					await hook();
				}
				return handleD1BridgeRequest(incoming, binding);
			},
		}),
	);
});
after(async () => runtime.dispose());

let sequence = 0;
async function fixture() {
	const suffix = String(++sequence);
	const ownerId = User.UserId.make(`owner${suffix}`);
	const orgId = Organisation.OrganisationId.make(`org${suffix}`);
	await database.insert(Db.users).values({
		id: ownerId,
		email: `${suffix}@example.test`,
		activeOrganizationId: orgId,
		stripeSubscriptionStatus: "active",
	});
	await database
		.insert(Db.organizations)
		.values({ id: orgId, ownerId, name: "Team" });
	const video = {
		id: Video.VideoId.make(`video${suffix}`),
		ownerId,
		orgId,
		name: "Recording",
		source: { type: "webMP4" as const },
	};
	return { ownerId, orgId, video };
}

test("video and initial upload roll back together on a late constraint failure", async () => {
	const { video } = await fixture();
	await database
		.insert(Db.videoUploads)
		.values({ videoId: video.id, total: 9 });
	await assert.rejects(
		createVideo(database, video, { initialUpload: { total: 1 } }),
	);
	assert.equal(
		(await database.select().from(Db.videos).where(eq(Db.videos.id, video.id)))
			.length,
		0,
	);
	assert.equal(
		(
			await database
				.select()
				.from(Db.videoUploads)
				.where(eq(Db.videoUploads.videoId, video.id))
		)[0]?.total,
		9,
	);
});

test("concurrent upload progress inserts one row and preserves the latest timestamp", async () => {
	const { video, ownerId } = await fixture();
	await createVideo(database, video);
	await Promise.all(
		[1, 4, 2, 3].map((value) =>
			updateVideoUploadProgress(database, ownerId, {
				videoId: video.id,
				uploaded: value,
				total: 10,
				updatedAt: new Date(2000000000000 + value),
			}),
		),
	);
	const [upload] = await database
		.select()
		.from(Db.videoUploads)
		.where(eq(Db.videoUploads.videoId, video.id));
	assert.equal(upload?.uploaded, 4);
	assert.equal(upload.updatedAt.getTime(), 2000000000004);
});

test("upload ownership changes between snapshot and commit reject the stale writer", async () => {
	const { video, ownerId } = await fixture();
	await createVideo(database, video);
	beforeBatch = async () => {
		await database
			.update(Db.videos)
			.set({ ownerId: User.UserId.make("different") })
			.where(eq(Db.videos.id, video.id));
	};
	await assert.rejects(
		updateVideoUploadProgress(database, ownerId, {
			videoId: video.id,
			uploaded: 1,
			total: 2,
			updatedAt: new Date(),
		}),
		/ownership/,
	);
	assert.equal(
		(
			await database
				.select()
				.from(Db.videoUploads)
				.where(eq(Db.videoUploads.videoId, video.id))
		).length,
		0,
	);
});

test("tombstone racing video creation rejects it and hides existing videos", async () => {
	const { video, orgId } = await fixture();
	await createVideo(database, video);
	beforeBatch = async () => {
		await database
			.update(Db.organizations)
			.set({ tombstoneAt: new Date() })
			.where(eq(Db.organizations.id, orgId));
	};
	await assert.rejects(
		createVideo(database, {
			...video,
			id: Video.VideoId.make(`${video.id}new`),
		}),
		/unavailable/,
	);
	assert.equal(
		(
			await database
				.select()
				.from(Db.videos)
				.where(and(eq(Db.videos.id, video.id), activeVideo))
		).length,
		0,
	);
});

test("membership revoked before video creation commits cannot publish", async () => {
	const { video, orgId } = await fixture();
	const memberId = User.UserId.make(`${video.ownerId}member`);
	await database.insert(Db.organizationMembers).values({
		id: `${orgId}membership`,
		organizationId: orgId,
		userId: memberId,
		role: "member",
	});
	beforeBatch = async () => {
		await database
			.delete(Db.organizationMembers)
			.where(eq(Db.organizationMembers.userId, memberId));
	};
	await assert.rejects(
		createVideo(database, { ...video, ownerId: memberId }),
		/membership/,
	);
});

test("prepared video deletion blocks upload writers and deletion is replayable", async () => {
	const { video, ownerId } = await fixture();
	await createVideo(database, video, { initialUpload: { total: 1 } });
	await prepareVideoDeletion(database, video.id, ownerId);
	await assert.rejects(
		updateVideoUploadProgress(database, ownerId, {
			videoId: video.id,
			uploaded: 1,
			total: 1,
			updatedAt: new Date(),
		}),
		/deleted/,
	);
	await deleteVideo(database, video.id, ownerId);
	await deleteVideo(database, video.id, ownerId);
	assert.equal(
		(
			await database
				.select()
				.from(Db.videoUploads)
				.where(eq(Db.videoUploads.videoId, video.id))
		).length,
		0,
	);
});

test("storage reservation has one stable winner and tombstones block object publication", async () => {
	const { video, ownerId, orgId } = await fixture();
	const integrationId = Storage.StorageIntegrationId.make(`${orgId}drive`);
	await database.insert(Db.storageIntegrations).values({
		id: integrationId,
		ownerId,
		organizationId: orgId,
		provider: "googleDrive",
		displayName: "Drive",
		active: true,
		encryptedConfig: "fixture",
	});
	await createVideo(database, {
		...video,
		storageIntegrationId: integrationId,
	});
	const objectKey = `${ownerId}/${video.id}/result.mp4`;
	const object = {
		id: Storage.StorageObjectId.make(`${video.id}object`),
		integrationId,
		ownerId,
		videoId: video.id,
		objectKey,
		objectKeyHash: createHash("sha256").update(objectKey).digest("hex"),
		providerObjectId: "first",
	};
	await Promise.all(
		["first", "second"].map((providerObjectId) =>
			writeStorageObject(
				database,
				{
					...object,
					id: Storage.StorageObjectId.make(`${video.id}${providerObjectId}`),
					providerObjectId,
				},
				{ reserve: true },
			),
		),
	);
	const rows = await database
		.select()
		.from(Db.storageObjects)
		.where(eq(Db.storageObjects.integrationId, integrationId));
	assert.equal(rows.length, 1);
	assert.ok(rows[0]);
	assert.ok(["first", "second"].includes(rows[0].providerObjectId));
	beforeBatch = async () => {
		await database
			.update(Db.organizations)
			.set({ tombstoneAt: new Date() })
			.where(eq(Db.organizations.id, orgId));
	};
	await assert.rejects(
		writeStorageObject(database, { ...object, providerObjectId: "third" }),
		/unavailable/,
	);
	assert.equal(
		(
			await database
				.select()
				.from(Db.storageObjects)
				.where(
					and(
						eq(Db.storageObjects.integrationId, integrationId),
						activeStorageObject,
					),
				)
		).length,
		0,
	);
});

test("storage service preserves exact prefixes, exclusive refresh leases and compare-and-swap", async () => {
	const { video, ownerId, orgId } = await fixture();
	const integrationId = Storage.StorageIntegrationId.make(`${orgId}drive`);
	await database.insert(Db.storageIntegrations).values({
		id: integrationId,
		ownerId,
		organizationId: orgId,
		provider: "googleDrive",
		displayName: "Drive",
		active: true,
		encryptedConfig: "fixture",
	});
	await createVideo(database, {
		...video,
		storageIntegrationId: integrationId,
	});
	const prefix = `${ownerId}/${video.id}/A_%/`;
	for (const suffix of ["A_%/one", "A_%/two", "a_%/three", "AXY/four"]) {
		await runStorage((repo) =>
			repo.reserveObject({
				integrationId,
				ownerId,
				videoId: video.id,
				objectKey: `${ownerId}/${video.id}/${suffix}`,
				providerObjectId: suffix,
			}),
		);
	}
	const first = await runStorage((repo) =>
		repo.listObjectsByPrefix(integrationId, prefix, 1, undefined),
	);
	assert.equal(first.objects.length, 1);
	assert.equal(first.objects[0]?.objectKey, `${prefix}one`);
	const second = await runStorage((repo) =>
		repo.listObjectsByPrefix(
			integrationId,
			prefix,
			1,
			first.nextContinuationToken,
		),
	);
	assert.equal(second.objects[0]?.objectKey, `${prefix}two`);
	assert.equal(second.nextContinuationToken, undefined);
	const leaseResults = await Promise.all(
		["one", "two"].map((lease) =>
			runStorage((repo) =>
				repo.claimGoogleDriveTokenRefreshLease(
					integrationId,
					lease,
					new Date(Date.now() + 60000),
				),
			),
		),
	);
	assert.equal(leaseResults.filter(Boolean).length, 1);
	const current = await runStorage((repo) =>
		repo.getObjectByKey(integrationId, `${prefix}one`),
	);
	assert.ok(Option.isSome(current));
	const swaps = await Promise.all(
		["new-one", "new-two"].map((providerObjectId) =>
			runStorage((repo) =>
				repo.updateObjectIfCurrent(current.value, { providerObjectId }),
			),
		),
	);
	assert.equal(swaps.filter(Boolean).length, 1);
	await prepareVideoDeletion(database, video.id, ownerId);
	const complete = await runStorage((repo) =>
		repo.markObjectComplete(integrationId, `${prefix}two`, 4),
	);
	assert.equal(complete.meta.changes, 0);
	await database
		.update(Db.organizations)
		.set({ tombstoneAt: new Date() })
		.where(eq(Db.organizations.id, orgId));
	assert.equal(
		(
			await runStorage((repo) =>
				repo.listObjectsByPrefix(integrationId, prefix, 10, undefined),
			)
		).objects.length,
		0,
	);
});

test("unpublished duplicate storage remains guarded by the source organization", async () => {
	const { video, ownerId, orgId } = await fixture();
	const integrationId = Storage.StorageIntegrationId.make(`${orgId}drive`);
	await database.insert(Db.storageIntegrations).values({
		id: integrationId,
		ownerId,
		organizationId: orgId,
		provider: "googleDrive",
		displayName: "Drive",
		active: true,
		encryptedConfig: "fixture",
	});
	await createVideo(database, {
		...video,
		storageIntegrationId: integrationId,
	});
	const copyId = Video.VideoId.make(`${video.id}copy`);
	const key = `${ownerId}/${copyId}/result.mp4`;
	await runStorage((repo) =>
		repo.upsertObject({
			integrationId,
			ownerId,
			videoId: copyId,
			objectKey: key,
			providerObjectId: "copy-file",
			metadata: { copySourceVideoId: video.id },
		}),
	);
	assert.ok(
		Option.isSome(
			await runStorage((repo) => repo.getObjectByKey(integrationId, key)),
		),
	);
	await createVideo(database, {
		...video,
		id: copyId,
		storageIntegrationId: integrationId,
	});
	await database
		.update(Db.organizations)
		.set({ tombstoneAt: new Date() })
		.where(eq(Db.organizations.id, orgId));
	await assert.rejects(
		runStorage((repo) =>
			repo.upsertObject({
				integrationId,
				ownerId,
				videoId: copyId,
				objectKey: key,
				providerObjectId: "overwrite",
			}),
		),
	);
});

test("concurrent folder moves cannot introduce a cycle", async () => {
	const { orgId, ownerId } = await fixture();
	const a = Folder.FolderId.make(`${orgId}a`);
	const b = Folder.FolderId.make(`${orgId}b`);
	await createFolder(database, {
		id: a,
		organizationId: orgId,
		createdById: ownerId,
		name: "A",
	});
	await createFolder(database, {
		id: b,
		organizationId: orgId,
		createdById: ownerId,
		name: "B",
	});
	const results = await Promise.allSettled([
		updateFolder(database, a, ownerId, { parentId: b }),
		updateFolder(database, b, ownerId, { parentId: a }),
	]);
	assert.equal(
		results.filter((result) => result.status === "fulfilled").length,
		1,
	);
});

test("concurrent public folder patches preserve independent JSON keys", async () => {
	const { orgId, ownerId } = await fixture();
	const id = Folder.FolderId.make(`${orgId}public`);
	await createFolder(database, {
		id,
		organizationId: orgId,
		createdById: ownerId,
		name: "Public",
		settings: { publicPage: { logoUrl: "retained-logo" } },
	});
	await Promise.all([
		updateFolder(database, id, ownerId, { publicPage: { title: "New title" } }),
		updateFolder(database, id, ownerId, {
			publicPage: { subtitle: "New subtitle" },
		}),
	]);
	const [folder] = await database
		.select()
		.from(Db.folders)
		.where(eq(Db.folders.id, id));
	assert.deepEqual(folder?.settings?.publicPage, {
		logoUrl: "retained-logo",
		title: "New title",
		subtitle: "New subtitle",
	});
});

test("folder tree deletion handles more than 100 descendants in one atomic plan", async () => {
	const { orgId, ownerId, video } = await fixture();
	const rootId = Folder.FolderId.make(`${orgId}root`);
	await createFolder(database, {
		id: rootId,
		organizationId: orgId,
		createdById: ownerId,
		name: "Root",
	});
	for (let index = 0; index < 105; index++)
		await database.insert(Db.folders).values({
			id: Folder.FolderId.make(`${orgId}child${index}`),
			parentId: rootId,
			organizationId: orgId,
			createdById: ownerId,
			name: "Child",
		});
	await createVideo(database, {
		...video,
		folderId: Folder.FolderId.make(`${orgId}child104`),
	});
	await deleteFolderTree(database, rootId, ownerId);
	assert.equal(
		(
			await database
				.select()
				.from(Db.folders)
				.where(eq(Db.folders.organizationId, orgId))
		).length,
		0,
	);
	assert.equal(
		(
			await database.select().from(Db.videos).where(eq(Db.videos.id, video.id))
		)[0]?.folderId,
		null,
	);
});

test("folder deletion rejects legacy children from another organization", async () => {
	const { orgId, ownerId } = await fixture();
	const foreign = await fixture();
	const rootId = Folder.FolderId.make(`${orgId}root`);
	await createFolder(database, {
		id: rootId,
		organizationId: orgId,
		createdById: ownerId,
		name: "Root",
	});
	await database.insert(Db.folders).values({
		id: Folder.FolderId.make(`${orgId}foreign`),
		parentId: rootId,
		organizationId: foreign.orgId,
		createdById: foreign.ownerId,
		name: "Foreign",
	});
	await assert.rejects(
		deleteFolderTree(database, rootId, ownerId),
		/boundaries/,
	);
	assert.equal(
		(await database.select().from(Db.folders).where(eq(Db.folders.id, rootId)))
			.length,
		1,
	);
});
