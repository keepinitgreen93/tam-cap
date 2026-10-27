import * as S3 from "@aws-sdk/client-s3";
import * as Db from "@cap/database/cloudflare/schema";
import { getTranscriptObjectKey } from "@cap/database/cloudflare/transcript-publication";
import {
	decryptEditTranscriptObject,
	encryptEditTranscriptObject,
} from "@cap/database/transcript-encryption";
import {
	CurrentUser,
	DatabaseError,
	type ImageUpload,
	Organisation,
	Storage as StorageDomain,
	User,
	Video,
} from "@cap/web-domain";
import type { SQL } from "drizzle-orm";
import { SQLiteSyncDialect } from "drizzle-orm/sqlite-core";
import { Cause, Effect, Exit, Logger, Option, Schema } from "effect";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	databaseRevision,
	snapshotGuard,
} from "../../../../packages/database/cloudflare/concurrency-schema";

const mocks = vi.hoisted(() => ({
	database: vi.fn(),
	bucketAccess: vi.fn(),
	driveDelete: vi.fn(),
	driveMetadata: vi.fn(),
	driveCopy: vi.fn(),
	driveText: vi.fn(),
	driveFind: vi.fn(),
	nextId: "duplicate-video",
}));

vi.mock("@cap/env", async (importOriginal) => ({
	...(await importOriginal<typeof import("@cap/env")>()),
	serverEnv: () => ({
		NEXTAUTH_SECRET: "synthetic-duplicate-transcript-secret",
		WEB_URL: "https://cap.test",
		CAP_VIDEOS_DEFAULT_PUBLIC: true,
	}),
}));
vi.mock("@cap/database", () => ({ db: mocks.database }));
vi.mock("@cap/database/cloudflare/application", () => ({ db: mocks.database }));
vi.mock("@cap/database/helpers", async (importOriginal) => ({
	...(await importOriginal<typeof import("@cap/database/helpers")>()),
	nanoId: () => mocks.nextId,
}));
vi.mock("@cap/web-backend/src/S3Buckets/index.ts", async () => {
	const { Effect } = await import("effect");
	class S3Buckets extends Effect.Service<S3Buckets>()("S3Buckets", {
		sync: () => ({ getBucketAccess: mocks.bucketAccess }),
	}) {}
	return { S3Buckets };
});
vi.mock("@cap/web-backend/src/Tinybird/index.ts", async () => {
	const { Effect } = await import("effect");
	class Tinybird extends Effect.Service<Tinybird>()("Tinybird", {
		sync: () => ({ querySql: () => Effect.succeed({ data: [] }) }),
	}) {}
	return { Tinybird };
});
vi.mock(
	"@cap/web-backend/src/Storage/GoogleDrive.ts",
	async (importOriginal) => ({
		...(await importOriginal<
			typeof import("@cap/web-backend/src/Storage/GoogleDrive")
		>()),
		deleteGoogleDriveFile: mocks.driveDelete,
		getGoogleDriveFileMetadata: mocks.driveMetadata,
		copyGoogleDriveFile: mocks.driveCopy,
		getGoogleDriveObjectText: mocks.driveText,
		findGoogleDriveFileByObjectKey: mocks.driveFind,
	}),
);

import { S3Buckets } from "@cap/web-backend/src/S3Buckets";
import { createS3BucketAccess } from "@cap/web-backend/src/S3Buckets/S3BucketAccess";
import { S3BucketClientProvider } from "@cap/web-backend/src/S3Buckets/S3BucketClientProvider";
import { Storage } from "@cap/web-backend/src/Storage";
import {
	type copyGoogleDriveFile,
	type GoogleDriveFile,
	GoogleDriveRequestError,
} from "@cap/web-backend/src/Storage/GoogleDrive";
import { StorageRepo } from "@cap/web-backend/src/Storage/StorageRepo";
import { Videos } from "@cap/web-backend/src/Videos";
import { VideosRepo } from "@cap/web-backend/src/Videos/VideosRepo";

const ownerId = User.UserId.make("owned-user");
const videoId = Video.VideoId.make("owned-video");
const orgId = Organisation.OrganisationId.make("owned-org");
const prefix = `${ownerId}/${videoId}/`;
const newPrefix = `${ownerId}/duplicate-video/`;
const outputKey = `${prefix}.recording/outputs/generation/attempt.mp4`;
const thumbnailKey = `${prefix}.recording/outputs/generation/attempt/screenshot.jpg`;
const previewKey = `${prefix}.recording/outputs/generation/attempt/preview.gif`;
const currentUser = {
	id: ownerId,
	email: "owner@example.test",
	activeOrganizationId: orgId,
	iconUrlOrKey: Option.none<ImageUpload.ImageUrlOrKey>(),
};

function recording(
	source: Video.Video["source"] = {
		type: "desktopMP4",
		outputKey,
		thumbnailKey,
		previewKey,
	},
) {
	return Video.Video.make({
		id: videoId,
		ownerId,
		orgId,
		name: "Retained recording",
		public: true,
		source,
		metadata: Option.some({
			sourceName: "Test display",
			desktopRecordingUpload: {
				version: 1,
				artifact: { kind: "segments", manifestSha256: "a".repeat(64) },
				fileSize: 4096,
				duration: 5,
				hasAudio: true,
				fullDecode: true,
				requiredAudioVerified: true,
				objectIdentity: '"old-output"',
				outputKey,
			},
		}),
		bucketId: Option.none(),
		storageIntegrationId: Option.none(),
		folderId: Option.none(),
		transcriptionStatus: Option.none(),
		width: Option.some(320),
		height: Option.some(180),
		duration: Option.some(5),
		createdAt: new Date(),
		updatedAt: new Date(),
	});
}

type DatabaseMutation = {
	operation: "insert" | "delete";
	table: unknown;
	id?: string;
	values?: Record<string, unknown>;
};

function databaseFixture(video = recording(), password?: string | null) {
	const encoded = Schema.encodeSync(Video.Video)(video);
	const original = {
		...encoded,
		bucket: encoded.bucketId,
		createdAt: video.createdAt,
		updatedAt: video.updatedAt,
		password: password ?? null,
	};
	const rows = new Map<string, Record<string, unknown>>([[videoId, original]]);
	const edits = new Map<string, Record<string, unknown>>();
	const jobs = new Map<string, Record<string, unknown>>([
		[
			videoId,
			{
				videoId,
				ownerId,
				generation: "active-generation",
				state: "processing",
			},
		],
	]);
	const uploads = new Map<string, typeof Db.videoUploads.$inferSelect>();
	const shares = new Map<unknown, Map<string, { videoId: string }>>(
		[Db.sharedVideos, Db.spaceVideos].map((table) => [
			table,
			new Map([
				["root-share", { videoId }],
				["folder-share", { videoId }],
				["other-share", { videoId: "other-video" }],
			]),
		]),
	);
	const mutations: DatabaseMutation[] = [];
	const events: string[] = [];
	const objectDeleteConditions: SQL[] = [];
	let beforeJobDelete: (() => Promise<void>) | undefined;
	let beforePrepareDelete: (() => Promise<void>) | undefined;
	let loseNextCreateResponse = false;
	const idFrom = (condition: SQL) => {
		const id = new SQLiteSyncDialect().sqlToQuery(condition).params[0];
		if (typeof id !== "string") throw new Error("Missing database video id");
		return id;
	};
	let revision = 0;
	let signature = "";
	const currentRevision = () => {
		const next = JSON.stringify([
			[...rows],
			[...jobs],
			[...uploads],
			[...edits],
		]);
		if (next !== signature) {
			signature = next;
			revision++;
		}
		return revision;
	};
	const read = (table: unknown, condition: SQL) => {
		if (table === databaseRevision) return [{ revision: currentRevision() }];
		if (table === Db.organizations)
			return [{ id: orgId, ownerId, tombstoneAt: null }];
		if (table === Db.organizationMembers) return [];
		if (table === Db.videoEdits) {
			const edit = edits.get(idFrom(condition));
			return edit ? [structuredClone(edit)] : [];
		}
		const source =
			table === Db.videos
				? rows
				: table === Db.videoProcessingJobs
					? jobs
					: null;
		if (!source) throw new Error("Unexpected table read");
		const row = source.get(idFrom(condition));
		return row ? [structuredClone(row)] : [];
	};
	type Mutation = DatabaseMutation &
		Promise<{ meta: { changes: number } }> & {
			onConflictDoUpdate: (input: { set: Record<string, unknown> }) => Mutation;
		};
	const mutation = (value: DatabaseMutation): Mutation =>
		Object.assign(Promise.resolve({ meta: { changes: 1 } }), value, {
			onConflictDoUpdate: ({ set }: { set: Record<string, unknown> }) =>
				mutation({ ...value, values: { ...value.values, ...set } }),
		});
	const batch = vi.fn(async (statements: Mutation[]) => {
		if (
			statements.some(
				(statement) =>
					statement.operation === "insert" &&
					statement.table === Db.videoProcessingJobs,
			)
		) {
			events.push("job-fence-request");
			await beforePrepareDelete?.();
		}
		const guard = statements.find(
			(statement) =>
				statement.table === snapshotGuard && statement.operation === "insert",
		);
		const valid = guard?.values?.valid;
		if (valid) {
			const expected = new SQLiteSyncDialect().sqlToQuery(valid as SQL)
				.params[0];
			if (expected !== currentRevision())
				throw new Error("CHECK constraint failed: cap_d1_snapshot_guard");
		}
		const pending = statements.filter(
			(statement) => statement.table !== snapshotGuard,
		);
		for (const statement of pending) {
			if (
				statement.operation === "delete" &&
				statement.table === Db.videoProcessingJobs
			) {
				events.push("job-delete-request");
				await beforeJobDelete?.();
				events.push("job-delete-complete");
			} else if (statement.operation === "delete")
				events.push("dependent-delete");
		}
		for (const statement of pending) {
			mutations.push(statement);
			const table =
				statement.table === Db.videos
					? rows
					: statement.table === Db.videoProcessingJobs
						? jobs
						: statement.table === Db.videoEdits
							? edits
							: null;
			const shareRows = shares.get(statement.table);
			if (shareRows && statement.operation === "delete")
				for (const [id, row] of shareRows)
					if (row.videoId === statement.id) shareRows.delete(id);
			if (!table) continue;
			if (statement.operation === "delete" && statement.id)
				table.delete(statement.id);
			if (statement.operation === "insert" && statement.values) {
				const id =
					statement.table === Db.videos
						? statement.values.id
						: statement.values.videoId;
				if (typeof id !== "string") throw new Error("Missing inserted id");
				table.set(id, statement.values);
			}
		}
		if (
			loseNextCreateResponse &&
			pending.some(
				({ operation, table }) => operation === "insert" && table === Db.videos,
			)
		) {
			loseNextCreateResponse = false;
			throw new Error("Committed video creation response was lost");
		}
		return [];
	});
	const selection = (table: unknown, condition: SQL) =>
		Object.assign(Promise.resolve(read(table, condition)), {
			limit: async () => read(table, condition),
		});
	mocks.database.mockReturnValue({
		select: () => ({
			from: (table: unknown) => ({
				where: (condition: SQL) => selection(table, condition),
				leftJoin: (joined: unknown) => ({
					where: async (condition: SQL) => {
						if (table !== Db.videoUploads || joined !== Db.videoProcessingJobs)
							throw new Error("Unexpected joined progress read");
						const id = idFrom(condition);
						const upload = uploads.get(id);
						return upload
							? [{ ...upload, processingJobState: jobs.get(id)?.state ?? null }]
							: [];
					},
				}),
			}),
		}),
		selectDistinct: () => {
			throw new Error("Unexpected distinct selection");
		},
		query: {},
		insert: (table: unknown) => ({
			values: (values: Record<string, unknown>) =>
				mutation({ operation: "insert", table, values }),
		}),
		delete: (table: unknown) => ({
			where: (condition: SQL) => {
				if (table === Db.storageObjects) objectDeleteConditions.push(condition);
				return mutation({
					operation: "delete",
					table,
					id: table === snapshotGuard ? undefined : idFrom(condition),
				});
			},
		}),
		batch,
	});
	return {
		rows,
		edits,
		jobs,
		uploads,
		shares,
		mutations,
		events,
		objectDeleteConditions,
		beforeJobDelete: (callback: () => Promise<void>) => {
			beforeJobDelete = callback;
		},
		beforePrepareDelete: (callback: () => Promise<void>) => {
			beforePrepareDelete = callback;
		},
		loseNextCreateResponse: () => {
			loseNextCreateResponse = true;
		},
	};
}

const clients: S3.S3Client[] = [];

async function storageFixture(seed: Iterable<readonly [string, string]>) {
	const objects = new Map(seed);
	const sizes = new Map(
		[...objects].map(([key, value]) => [key, value.length]),
	);
	const identities = new Map(
		[...objects.keys()].map((key, index) => [key, `"source-${index}"`]),
	);
	const requests: Array<{
		operation:
			| "copy"
			| "list"
			| "delete"
			| "head"
			| "multipart-create"
			| "multipart-part"
			| "multipart-complete"
			| "multipart-abort";
		source?: string;
		key?: string;
		keys?: string[];
		token?: string;
	}> = [];
	const copyInputs: S3.CopyObjectCommandInput[] = [];
	const partInputs: S3.UploadPartCopyCommandInput[] = [];
	const completeInputs: S3.CompleteMultipartUploadCommandInput[] = [];
	const createInputs: S3.CreateMultipartUploadCommandInput[] = [];
	const uploads = new Map<
		string,
		{
			key: string;
			parts: Map<
				number,
				{ source: string; start: number; end: number; etag: string }
			>;
		}
	>();
	const deniedDeletes = new Set<string>();
	let copyFailure: string | undefined;
	let listFailure: string | undefined;
	let failedPart: number | undefined;
	let malformedPagination: "missing" | "repeated" | undefined;
	let beforeDelete: (() => void) | undefined;
	let beforeCopy: (() => void) | undefined;
	let afterCopy: (() => void) | undefined;
	const client = new S3.S3Client({
		credentials: { accessKeyId: "test-key", secretAccessKey: "test-secret" },
		endpoint: "http://storage.test",
		region: "us-east-1",
		forcePathStyle: true,
	});
	clients.push(client);
	const sourceKeyFrom = (source: string | undefined) => {
		if (!source?.startsWith("test-bucket/"))
			throw new Error("Invalid copy source");
		return decodeURIComponent(source.slice("test-bucket/".length));
	};
	const copy = (
		sourceKey: string,
		key: string,
		size: number,
		identity: string,
	) => {
		const content = objects.get(sourceKey);
		if (content === undefined) throw new Error("Copy source not found");
		objects.set(key, content);
		sizes.set(key, size);
		identities.set(key, identity);
		afterCopy?.();
	};
	vi.spyOn(client, "send").mockImplementation(async (command) => {
		if (command instanceof S3.GetObjectCommand) {
			const key = command.input.Key;
			if (!key || !objects.has(key))
				throw new S3.NoSuchKey({
					message: "Object missing",
					$metadata: { httpStatusCode: 404 },
				});
			return {
				Body: { transformToString: async () => objects.get(key) },
				$metadata: {},
			};
		}
		if (command instanceof S3.PutObjectCommand) {
			const key = command.input.Key;
			if (!key || typeof command.input.Body !== "string")
				throw new Error("Unexpected transcript put");
			objects.set(key, command.input.Body);
			sizes.set(key, new TextEncoder().encode(command.input.Body).byteLength);
			identities.set(key, `"transcript-${key}"`);
			return { ETag: identities.get(key), $metadata: {} };
		}
		if (command instanceof S3.HeadObjectCommand) {
			const key = command.input.Key;
			if (!key || !objects.has(key)) throw new Error("Object not found");
			requests.push({ operation: "head", key });
			return {
				ContentLength: sizes.get(key),
				ETag: identities.get(key),
				ContentType: "video/mp4",
				Metadata: { recording: "retained" },
				$metadata: {},
			};
		}
		if (command instanceof S3.CopyObjectCommand) {
			const sourceKey = sourceKeyFrom(command.input.CopySource);
			const key = command.input.Key;
			if (!key) throw new Error("Missing copy destination");
			beforeCopy?.();
			requests.push({ operation: "copy", source: sourceKey, key });
			copyInputs.push(command.input);
			if (key === copyFailure) throw new Error("Copy unavailable");
			if (command.input.CopySourceIfMatch !== identities.get(sourceKey))
				throw new Error("Source precondition failed");
			const size = sizes.get(sourceKey);
			if (size === undefined || size > 5 * 1024 ** 3)
				throw new Error("Single-copy size limit");
			const identity = `"copied-${key}"`;
			copy(sourceKey, key, size, identity);
			return { CopyObjectResult: { ETag: identity }, $metadata: {} };
		}
		if (command instanceof S3.CreateMultipartUploadCommand) {
			const key = command.input.Key;
			if (!key) throw new Error("Missing multipart destination");
			beforeCopy?.();
			const UploadId = `copy-upload-${createInputs.length}`;
			createInputs.push(command.input);
			uploads.set(UploadId, { key, parts: new Map() });
			requests.push({ operation: "multipart-create", key });
			return { UploadId, $metadata: {} };
		}
		if (command instanceof S3.UploadPartCopyCommand) {
			const {
				Key: key,
				UploadId: uploadId,
				PartNumber: partNumber,
			} = command.input;
			const upload = uploadId ? uploads.get(uploadId) : undefined;
			const sourceKey = sourceKeyFrom(command.input.CopySource);
			if (!upload || upload.key !== key || !partNumber)
				throw new Error("Invalid multipart part");
			partInputs.push(command.input);
			requests.push({ operation: "multipart-part", key, source: sourceKey });
			if (partNumber === failedPart) throw new Error("Part copy unavailable");
			if (command.input.CopySourceIfMatch !== identities.get(sourceKey))
				throw new Error("Source precondition failed");
			const range = /^bytes=(\d+)-(\d+)$/.exec(
				command.input.CopySourceRange ?? "",
			);
			if (!range) throw new Error("Missing part range");
			const start = Number(range[1]);
			const end = Number(range[2]);
			const etag = `"part-${partNumber}"`;
			upload.parts.set(partNumber, { source: sourceKey, start, end, etag });
			return { CopyPartResult: { ETag: etag }, $metadata: {} };
		}
		if (command instanceof S3.CompleteMultipartUploadCommand) {
			const { Key: key, UploadId: uploadId } = command.input;
			const upload = uploadId ? uploads.get(uploadId) : undefined;
			if (
				!key ||
				!upload ||
				command.input.IfNoneMatch !== "*" ||
				objects.has(key)
			)
				throw new Error("Invalid multipart completion");
			completeInputs.push(command.input);
			requests.push({ operation: "multipart-complete", key });
			let position = 0;
			let sourceKey: string | undefined;
			for (const [index, completed] of (
				command.input.MultipartUpload?.Parts ?? []
			).entries()) {
				const part = upload.parts.get(index + 1);
				if (
					!part ||
					completed.PartNumber !== index + 1 ||
					completed.ETag !== part.etag ||
					part.start !== position
				)
					throw new Error("Incomplete multipart sequence");
				position = part.end + 1;
				sourceKey = part.source;
			}
			if (!sourceKey || position !== sizes.get(sourceKey))
				throw new Error("Incomplete multipart copy");
			const identity = '"multipart-output-etag"';
			copy(sourceKey, key, position, identity);
			if (uploadId) uploads.delete(uploadId);
			return { ETag: identity, $metadata: {} };
		}
		if (command instanceof S3.AbortMultipartUploadCommand) {
			if (command.input.UploadId) uploads.delete(command.input.UploadId);
			requests.push({ operation: "multipart-abort", key: command.input.Key });
			return { $metadata: {} };
		}
		if (command instanceof S3.ListObjectsV2Command) {
			const token = command.input.ContinuationToken;
			requests.push({ operation: "list", token });
			if (token !== undefined && token === listFailure)
				throw new Error("Listing unavailable");
			const keys = [...objects.keys()]
				.filter(
					(key) =>
						key.startsWith(command.input.Prefix ?? "") &&
						(token === undefined || key > token),
				)
				.sort();
			const page = keys.slice(0, 1000);
			return {
				Contents: page.map((Key) => ({ Key, Size: sizes.get(Key) })),
				IsTruncated:
					malformedPagination !== undefined || keys.length > page.length,
				NextContinuationToken:
					malformedPagination === "missing"
						? undefined
						: malformedPagination === "repeated"
							? "repeated-token"
							: keys.length > page.length
								? page.at(-1)
								: undefined,
				$metadata: {},
			};
		}
		if (command instanceof S3.DeleteObjectsCommand) {
			beforeDelete?.();
			const keys = (command.input.Delete?.Objects ?? [])
				.map((object) => object.Key)
				.filter((key): key is string => key !== undefined);
			requests.push({ operation: "delete", keys });
			for (const key of keys) {
				if (!deniedDeletes.has(key)) {
					objects.delete(key);
					sizes.delete(key);
					identities.delete(key);
				}
			}
			return {
				Deleted: keys
					.filter((key) => !deniedDeletes.has(key))
					.map((Key) => ({ Key })),
				Errors: keys
					.filter((key) => deniedDeletes.has(key))
					.map((Key) => ({ Key, Code: "AccessDenied" })),
				$metadata: {},
			};
		}
		throw new Error("Unexpected S3 request");
	});
	const access = await Effect.runPromise(
		createS3BucketAccess.pipe(
			Effect.provideService(S3BucketClientProvider, {
				bucket: "test-bucket",
				getInternal: Effect.succeed(client),
				getPublic: Effect.succeed(client),
				isPathStyle: true,
			}),
		),
	);
	mocks.bucketAccess.mockReturnValue(Effect.succeed([access, Option.none()]));
	return {
		access,
		objects,
		sizes,
		identities,
		requests,
		copyInputs,
		partInputs,
		completeInputs,
		createInputs,
		uploads,
		deniedDeletes,
		failCopy: (key: string) => {
			copyFailure = key;
		},
		failList: (token: string) => {
			listFailure = token;
		},
		failPart: (partNumber: number) => {
			failedPart = partNumber;
		},
		malformedPagination: (kind: "missing" | "repeated") => {
			malformedPagination = kind;
		},
		beforeDelete: (callback: () => void) => {
			beforeDelete = callback;
		},
		beforeCopy: (callback: () => void) => {
			beforeCopy = callback;
		},
		afterCopy: (callback: () => void) => {
			afterCopy = callback;
		},
	};
}

async function driveFixture() {
	const database = databaseFixture();
	const integrationId =
		StorageDomain.StorageIntegrationId.make("drive-integration");
	const now = new Date();
	const integration: typeof Db.storageIntegrations.$inferSelect = {
		id: integrationId,
		ownerId,
		organizationId: orgId,
		provider: "googleDrive",
		displayName: "Test Drive",
		status: "active",
		active: true,
		encryptedConfig: "unused-encrypted-fixture",
		googleDriveAccessToken: null,
		googleDriveAccessTokenExpiresAt: null,
		googleDriveTokenRefreshLeaseId: null,
		googleDriveTokenRefreshLeaseExpiresAt: null,
		googleDriveStorageQuotaCache: null,
		createdAt: now,
		updatedAt: now,
	};
	const original: typeof Db.storageObjects.$inferSelect = {
		id: StorageDomain.StorageObjectId.make("source-object"),
		integrationId,
		ownerId,
		videoId,
		objectKey: outputKey,
		objectKeyHash: "a".repeat(64),
		providerObjectId: "original-file",
		uploadSessionUrl: null,
		uploadStatus: "complete",
		contentType: "video/mp4",
		contentLength: 10,
		metadata: null,
		createdAt: now,
		updatedAt: now,
	};
	const records = new Map([[outputKey, original]]);
	const files = new Map<string, GoogleDriveFile>([
		[
			"original-file",
			{
				id: "original-file",
				version: "1",
				size: "10",
				mimeType: "video/mp4",
				sha256Checksum: "a".repeat(64),
				headRevisionId: "revision-1",
			},
		],
	]);
	const repo = await Effect.runPromise(
		StorageRepo.pipe(Effect.provide(StorageRepo.Default)),
	);
	vi.spyOn(repo, "assertVideoAccess").mockReturnValue(
		Effect.succeed(undefined),
	);
	vi.spyOn(repo, "assertOrganizationAccess").mockReturnValue(
		Effect.succeed(undefined),
	);
	vi.spyOn(repo, "getIntegrationById").mockReturnValue(
		Effect.succeed(Option.some(integration)),
	);
	vi.spyOn(repo, "getGoogleDriveConfig").mockReturnValue(
		Effect.succeed({
			refreshToken: "fixture-token",
			folderId: "fixture-folder",
		}),
	);
	const getIndex = vi
		.spyOn(repo, "getObjectByKey")
		.mockImplementation((_integration, key) =>
			Effect.sync(() =>
				Option.map(Option.fromNullable(records.get(key)), (object) =>
					structuredClone(object),
				),
			),
		);
	const updateIndex = vi
		.spyOn(repo, "updateObjectIfCurrent")
		.mockImplementation((object, input) =>
			Effect.sync(() => {
				const current = records.get(object.objectKey);
				if (
					!current ||
					current.id !== object.id ||
					current.integrationId !== object.integrationId ||
					current.objectKey !== object.objectKey ||
					current.objectKeyHash !== object.objectKeyHash ||
					current.providerObjectId !== object.providerObjectId ||
					current.uploadStatus !== object.uploadStatus
				)
					return false;
				records.set(object.objectKey, {
					...current,
					providerObjectId: input.providerObjectId,
					uploadStatus: input.uploadStatus ?? "pending",
					contentType: input.contentType ?? null,
					contentLength: input.contentLength ?? null,
					metadata: input.preserveMetadata
						? current.metadata
						: (input.metadata ?? null),
				});
				return true;
			}),
		);
	const deleteFromRepo = repo.deleteObjectByKey;
	const deleteIndex = vi
		.spyOn(repo, "deleteObjectByKey")
		.mockImplementation((...args) =>
			deleteFromRepo(...args).pipe(
				Effect.tap(() =>
					Effect.sync(() => {
						if (
							args[2] === undefined ||
							records.get(args[1])?.providerObjectId === args[2]
						)
							records.delete(args[1]);
					}),
				),
			),
		);
	mocks.driveDelete.mockReset().mockReturnValue(Effect.void);
	mocks.driveText
		.mockReset()
		.mockReturnValue(Effect.succeed("fixture-recording-text"));
	mocks.driveFind
		.mockReset()
		.mockReturnValue(Effect.succeed(Option.none<GoogleDriveFile>()));
	mocks.driveMetadata
		.mockReset()
		.mockImplementation((_config: unknown, fileId: string) =>
			Effect.sync(() => {
				const file = files.get(fileId);
				if (!file) throw new Error("Missing Google Drive file fixture");
				return { ...file };
			}),
		);
	mocks.driveCopy
		.mockReset()
		.mockImplementation(
			({ input, sourceFileId }: Parameters<typeof copyGoogleDriveFile>[0]) =>
				Effect.sync(() => {
					const source = files.get(sourceFileId);
					if (!source)
						throw new Error("Missing Google Drive copy source fixture");
					files.set("copied-file", {
						...source,
						id: "copied-file",
						version: "1",
					});
					records.set(input.key, {
						...original,
						id: StorageDomain.StorageObjectId.make("copied-object"),
						objectKey: input.key,
						providerObjectId: "copied-file",
					});
				}),
		);
	const video = Video.Video.make({
		...recording({ type: "desktopMP4", outputKey }),
		storageIntegrationId: Option.some(integrationId),
	});
	const [access] = await Effect.runPromise(
		Effect.flatMap(Storage, (storage) => storage.getAccessForVideo(video)).pipe(
			Effect.provide(Storage.DefaultWithoutDependencies),
			Effect.provideService(StorageRepo, repo),
			Effect.provide(S3Buckets.Default),
		),
	);
	return {
		access,
		records,
		files,
		integrationId,
		deleteIndex,
		deleteConditions: database.objectDeleteConditions,
		getIndex,
		updateIndex,
	};
}

function runVideoOperation(
	operation: "duplicate" | "delete",
	userId = ownerId,
) {
	return Effect.runPromiseExit(
		Effect.gen(function* () {
			const videos = yield* Videos;
			return yield* videos[operation](videoId);
		}).pipe(
			Effect.provide(Videos.Default),
			Effect.provideService(CurrentUser, { ...currentUser, id: userId }),
			Effect.provide(Logger.remove(Logger.defaultLogger)),
		),
	);
}

beforeEach(() => {
	mocks.nextId = "duplicate-video";
});

afterEach(() => {
	vi.unstubAllEnvs();
	for (const client of clients.splice(0)) client.destroy();
});

describe("recording storage lifecycle", () => {
	it("uses R2 PUT uploads with signed metadata and fresh-object preconditions", async () => {
		vi.stubEnv("CAP_RUNTIME", "cloudflare");
		databaseFixture();
		await storageFixture([]);
		const [access] = await Storage.getAccessForVideo(recording()).pipe(
			Effect.provide(Storage.Default),
			Effect.runPromise,
		);
		const target = await Effect.runPromise(
			access.createUploadTarget(`${prefix}new.mp4`, {
				contentType: "video/mp4",
				fields: { "x-amz-meta-userid": ownerId, "x-amz-meta-duration": "10" },
				ifNoneMatch: "*",
			}),
		);
		expect(target.type).toBe("put");
		if (target.type !== "put") throw new Error("Expected a PUT target");
		expect(target.headers).toEqual({
			"Content-Type": "video/mp4",
			"x-amz-meta-userid": ownerId,
			"x-amz-meta-duration": "10",
			"If-None-Match": "*",
		});
		const signed = new URL(target.url).searchParams.get("X-Amz-SignedHeaders");
		for (const header of [
			"content-type",
			"if-none-match",
			"x-amz-meta-userid",
			"x-amz-meta-duration",
		])
			expect(signed).toContain(header);
	});
	it("preserves POST upload support for custom S3 providers", async () => {
		vi.stubEnv("CAP_RUNTIME", "cloudflare");
		databaseFixture();
		const fixture = await storageFixture([]);
		mocks.bucketAccess.mockReturnValue(
			Effect.succeed([fixture.access, Option.some({ id: "custom-bucket" })]),
		);
		const [access] = await Storage.getAccessForVideo(recording()).pipe(
			Effect.provide(Storage.Default),
			Effect.runPromise,
		);
		const target = await Effect.runPromise(
			access.createUploadTarget(`${prefix}new.mp4`, {
				contentType: "video/mp4",
			}),
		);
		expect(target.type).toBe("s3Post");
	});
	it.each(["desktopMP4", "webMP4"] as const)(
		"uses the published %s thumbnail without discovering older objects",
		async (type) => {
			const editThumbnail = `${prefix}.recording/outputs/edit-11111111-1111-4111-8111-111111111111/thumbnail.jpg`;
			databaseFixture(recording({ type, thumbnailKey: editThumbnail }));
			const storage = await storageFixture([
				[editThumbnail, "current-thumbnail"],
				[`${prefix}screenshot/screen-capture.jpg`, "old-thumbnail"],
			]);
			const thumbnail = await Effect.runPromise(
				Effect.flatMap(Videos, (videos) =>
					videos.getThumbnailURL(videoId),
				).pipe(
					Effect.provide(Videos.Default),
					Effect.provideService(CurrentUser, currentUser),
				),
			);
			expect(Option.getOrNull(thumbnail)).toContain(editThumbnail);
			expect(
				storage.requests.filter(({ operation }) => operation === "list"),
			).toEqual([]);
		},
	);
	it.each([
		"committing",
		"queued",
		"processing",
		"retry",
		"source-blocked",
		null,
	] as const)(
		"reports durable state %s without treating recoverable worker failures as final failures",
		async (state) => {
			const database = databaseFixture();
			const previousUpdate = new Date(Date.now() - 60 * 60 * 1000);
			database.uploads.set(videoId, {
				videoId,
				uploaded: 100,
				total: 100,
				startedAt: previousUpdate,
				updatedAt: previousUpdate,
				mode: "multipart",
				phase: "error",
				processingProgress: 50,
				processingMessage: "Source retained",
				processingError: "Previous processing attempt failed",
				rawFileKey: null,
			});
			if (state) database.jobs.set(videoId, { state });
			else database.jobs.delete(videoId);
			const result = await Effect.runPromise(
				Effect.flatMap(Videos, (videos) =>
					videos.getUploadProgress(videoId),
				).pipe(
					Effect.provide(Videos.Default),
					Effect.provideService(CurrentUser, currentUser),
					Effect.provide(Logger.remove(Logger.defaultLogger)),
				),
			);
			const progress = Option.getOrThrow(result);
			expect(progress.updatedAt).toEqual(previousUpdate);
			if (state === "source-blocked" || state === null) {
				expect(progress.phase).toBe("error");
				expect(progress.automaticRetry).toBe(false);
				expect(progress.processingError).toEqual(
					Option.some("Previous processing attempt failed"),
				);
			} else {
				expect(progress.phase).toBe("processing");
				expect(progress.automaticRetry).toBe(true);
				expect(progress.processingError).toEqual(Option.none());
			}
		},
	);

	it("duplicates the published video and hidden assets into canonical destinations", async () => {
		const database = databaseFixture();
		const storage = await storageFixture([
			[outputKey, "verified-video"],
			[thumbnailKey, "verified-thumbnail"],
			[previewKey, "verified-preview"],
			[`${prefix}result.mp4`, "stale-canonical-video"],
			[`${prefix}screenshot/screen-capture.jpg`, "stale-thumbnail"],
		]);
		storage.beforeCopy(() =>
			expect(database.rows.has("duplicate-video")).toBe(false),
		);
		const result = await runVideoOperation("duplicate");
		expect(Exit.isSuccess(result)).toBe(true);
		expect(storage.objects.get(`${newPrefix}result.mp4`)).toBe(
			"verified-video",
		);
		expect(
			storage.objects.get(`${newPrefix}screenshot/screen-capture.jpg`),
		).toBe("verified-thumbnail");
		expect(
			storage.objects.get(`${newPrefix}preview/animated-preview.gif`),
		).toBe("verified-preview");
		expect(database.rows.get("duplicate-video")).toMatchObject({
			source: { type: "desktopMP4" },
			metadata: { sourceName: "Test display" },
		});
		expect(database.rows.get("duplicate-video")?.metadata).not.toHaveProperty(
			"desktopRecordingUpload",
		);
		expect(database.rows.get("duplicate-video")?.createdAt).toBeInstanceOf(
			Date,
		);
		expect(database.rows.get("duplicate-video")?.updatedAt).toEqual(
			database.rows.get("duplicate-video")?.createdAt,
		);
		expect(database.rows.get("owned-video")?.metadata).toHaveProperty(
			"desktopRecordingUpload",
		);
		expect(
			storage.requests.filter(({ operation }) => operation === "copy"),
		).toEqual([
			{ operation: "copy", source: outputKey, key: `${newPrefix}result.mp4` },
			{
				operation: "copy",
				source: thumbnailKey,
				key: `${newPrefix}screenshot/screen-capture.jpg`,
			},
			{
				operation: "copy",
				source: previewKey,
				key: `${newPrefix}preview/animated-preview.gif`,
			},
		]);
	});
	it("duplicates enhanced browser playback without retaining foreign audio pointers", async () => {
		const audioKey = `${prefix}.recording/outputs/audio-quality-v3/selected.mp4`;
		const database = databaseFixture(
			recording({
				type: "webMP4",
				audioLevelSourceKey: `${prefix}result.mp4`,
				audioLevelOutputKey: audioKey,
			}),
		);
		const storage = await storageFixture([
			[audioKey, "enhanced"],
			[`${prefix}result.mp4`, "original"],
		]);
		const result = await runVideoOperation("duplicate");
		expect(Exit.isSuccess(result)).toBe(true);
		expect(storage.objects.get(`${newPrefix}result.mp4`)).toBe("enhanced");
		expect(database.rows.get("duplicate-video")?.source).toEqual({
			type: "webMP4",
		});
		expect(storage.objects.get(`${prefix}result.mp4`)).toBe("original");
	});

	it("preserves password and strips customCreatedAt without copying original createdAt or updatedAt", async () => {
		const videoWithCustomDate = Video.Video.make({
			...recording(),
			createdAt: new Date("2020-01-01T00:00:00Z"),
			updatedAt: new Date("2020-01-02T00:00:00Z"),
			metadata: Option.some({
				sourceName: "Dated recording",
				customCreatedAt: "2020-01-01T00:00:00.000Z",
			}),
		});
		const database = databaseFixture(videoWithCustomDate, "secret-pass-123");
		await storageFixture([
			[outputKey, "verified-video"],
			[thumbnailKey, "verified-thumbnail"],
			[previewKey, "verified-preview"],
		]);
		const result = await runVideoOperation("duplicate");
		expect(Exit.isSuccess(result)).toBe(true);
		const duplicated = database.rows.get("duplicate-video");
		expect(duplicated).toBeDefined();
		expect(duplicated?.createdAt).toBeInstanceOf(Date);
		expect(duplicated?.createdAt).not.toEqual(videoWithCustomDate.createdAt);
		expect(duplicated?.updatedAt).toBeInstanceOf(Date);
		expect(duplicated?.updatedAt).not.toEqual(videoWithCustomDate.updatedAt);
		expect(duplicated?.metadata).not.toHaveProperty("customCreatedAt");
		expect(duplicated).toMatchObject({
			password: "secret-pass-123",
		});
	});

	it("does not duplicate source inventories, raw fragments, or comment attachments across pages", async () => {
		const database = databaseFixture();
		const retained = Array.from(
			{ length: 1100 },
			(_, index) =>
				[
					`${prefix}.recording/sources/generation/snapshot/video/${String(index).padStart(5, "0")}.m4s`,
					"source-fragment",
				] as const,
		);
		const storage = await storageFixture([
			...retained,
			[outputKey, "verified-video"],
			[thumbnailKey, "verified-thumbnail"],
			[previewKey, "verified-preview"],
			[
				`${prefix}.recording/sources/generation/snapshot/inventory.json`,
				"inventory",
			],
			[
				`${prefix}.recording/outputs/old-generation/old-attempt.mp4`,
				"old-output",
			],
			[`${prefix}segments/video/0.m4s`, "legacy-raw-fragment"],
			[`${prefix}comments/comment/attachment.mp4`, "comment-attachment"],
			[`${prefix}transcription.vtt`, "published-transcription"],
			[`${prefix}chapter-data.json`, "published-chapters"],
		]);
		const result = await runVideoOperation("duplicate");
		expect(Exit.isSuccess(result)).toBe(true);
		expect(
			storage.requests.filter(({ operation }) => operation === "list"),
		).toHaveLength(2);
		const transcriptKey = getTranscriptObjectKey(
			{
				id: Video.VideoId.make("duplicate-video"),
				ownerId,
				metadata: database.rows.get("duplicate-video")
					?.metadata as typeof Db.videos.$inferSelect.metadata,
			},
			"vtt",
		);
		if (!transcriptKey)
			throw new Error("Missing duplicated transcript pointer");
		expect(storage.objects.get(transcriptKey)).toBe("published-transcription");
		expect(
			[...storage.objects.keys()]
				.filter((key) => key.startsWith(newPrefix))
				.sort(),
		).toEqual([
			transcriptKey,
			`${newPrefix}chapter-data.json`,
			`${newPrefix}preview/animated-preview.gif`,
			`${newPrefix}result.mp4`,
			`${newPrefix}screenshot/screen-capture.jpg`,
		]);
		expect(database.rows.get("duplicate-video")?.source).toEqual({
			type: "desktopMP4",
		});
		expect(storage.objects.get(retained.at(-1)?.[0] ?? "")).toBe(
			"source-fragment",
		);
	});

	it("duplicates original-timeline words with target encryption and the preserved edit source", async () => {
		const database = databaseFixture();
		const originalWords = JSON.stringify({
			version: 3,
			durationMs: 10000,
			words: [{ id: "one", text: "hello", startMs: 1000, endMs: 1500 }],
		});
		const originalSource = `${prefix}source/original.mp4`;
		const editSpec = {
			version: 1,
			sourceDuration: 10,
			keepRanges: [{ start: 0, end: 5 }],
		};
		database.edits.set(videoId, {
			videoId,
			sourceKey: originalSource,
			editSpec,
			createdAt: new Date(),
			updatedAt: new Date(),
		});
		const storage = await storageFixture([
			[outputKey, "edited-video"],
			[thumbnailKey, "thumbnail"],
			[previewKey, "preview"],
			[originalSource, "original-video"],
			[`${prefix}transcription.vtt`, "WEBVTT\n\n"],
			[
				`${prefix}transcription.edit.v3.json`,
				encryptEditTranscriptObject(originalWords, ownerId, videoId),
			],
			[`${prefix}.transcripts/old-version/transcription.vtt`, "old-captions"],
		]);
		expect(Exit.isSuccess(await runVideoOperation("duplicate"))).toBe(true);
		const targetId = Video.VideoId.make("duplicate-video");
		const metadata = database.rows.get(targetId)
			?.metadata as typeof Db.videos.$inferSelect.metadata;
		const editKey = getTranscriptObjectKey(
			{ id: targetId, ownerId, metadata },
			"edit",
		);
		if (!editKey) throw new Error("Missing duplicated word transcript");
		const encrypted = storage.objects.get(editKey);
		if (!encrypted) throw new Error("Missing encrypted duplicate");
		expect(decryptEditTranscriptObject(encrypted, ownerId, targetId)).toBe(
			originalWords,
		);
		expect(decryptEditTranscriptObject(encrypted, ownerId, videoId)).toBeNull();
		expect(database.edits.get(targetId)).toMatchObject({
			sourceKey: `${newPrefix}source/original.mp4`,
			editSpec,
		});
		expect(storage.objects.get(`${newPrefix}source/original.mp4`)).toBe(
			"original-video",
		);
		expect(
			storage.objects.has(
				`${newPrefix}.transcripts/old-version/transcription.vtt`,
			),
		).toBe(false);
	});

	it("copies a published MP4 snapshot without retaining its original output pointer", async () => {
		const snapshotKey = `${prefix}.recording/sources/generation/snapshot/mp4/0.mp4`;
		const database = databaseFixture(
			recording({ type: "desktopMP4", outputKey: snapshotKey }),
		);
		const storage = await storageFixture([
			[snapshotKey, "verified-snapshot"],
			[`${prefix}result.mp4`, "new-unverified-upload"],
		]);
		expect(Exit.isSuccess(await runVideoOperation("duplicate"))).toBe(true);
		expect(storage.objects.get(`${newPrefix}result.mp4`)).toBe(
			"verified-snapshot",
		);
		expect(database.rows.get("duplicate-video")?.source).toEqual({
			type: "desktopMP4",
		});
		expect(
			storage.objects.has(
				`${newPrefix}.recording/sources/generation/snapshot/mp4/0.mp4`,
			),
		).toBe(false);
	});

	it("preserves the legacy canonical MP4 copy contract without copying cleanup receipts", async () => {
		const database = databaseFixture(recording({ type: "desktopMP4" }));
		const storage = await storageFixture([
			[`${prefix}result.mp4`, "legacy-recording"],
			[`${prefix}screenshot/screen-capture.jpg`, "legacy-thumbnail"],
		]);
		expect(Exit.isSuccess(await runVideoOperation("duplicate"))).toBe(true);
		expect(storage.objects.get(`${newPrefix}result.mp4`)).toBe(
			"legacy-recording",
		);
		expect(database.rows.get("duplicate-video")?.metadata).toEqual({
			sourceName: "Test display",
			transcriptPublication: {
				version: 1,
				id: expect.any(String),
				vtt: false,
				edit: false,
				revision: null,
			},
		});
	});

	it.each(["duplicate", "delete"] as const)(
		"does not %s another owner's recording or media",
		async (operation) => {
			const database = databaseFixture();
			const storage = await storageFixture([[outputKey, "verified-video"]]);
			const result = await runVideoOperation(
				operation,
				User.UserId.make("different-user"),
			);
			expect(Exit.isFailure(result)).toBe(true);
			expect(database.rows.has(videoId)).toBe(true);
			expect(database.mutations).toEqual([]);
			expect(storage.requests).toEqual([]);
		},
	);

	it("removes organization and space shares only for the deleted recording", async () => {
		const database = databaseFixture();
		await storageFixture([[outputKey, "verified-video"]]);

		expect(Exit.isSuccess(await runVideoOperation("delete"))).toBe(true);
		expect(database.rows.has(videoId)).toBe(false);
		for (const table of [Db.sharedVideos, Db.spaceVideos]) {
			expect(database.shares.get(table)).toEqual(
				new Map([["other-share", { videoId: "other-video" }]]),
			);
		}
	});

	it("waits for job deletion before deleting any dependent database row", async () => {
		const database = databaseFixture();
		let release: (() => void) | undefined;
		const gate = new Promise<void>((resolve) => {
			release = resolve;
		});
		database.beforeJobDelete(() => gate);
		const pending = Effect.runPromise(
			Effect.flatMap(VideosRepo, (repo) => repo.delete(videoId)).pipe(
				Effect.provide(VideosRepo.Default),
			),
		);
		await vi.waitFor(() =>
			expect(database.events).toEqual(["job-delete-request"]),
		);
		expect(database.rows.has(videoId)).toBe(true);
		expect(database.mutations).toEqual([]);
		if (!release) throw new Error("Missing job deletion resolver");
		release();
		await pending;
		expect(database.events.slice(0, 2)).toEqual([
			"job-delete-request",
			"job-delete-complete",
		]);
		expect(database.mutations.at(0)?.table).toBe(Db.videoProcessingJobs);
		expect(database.rows.has(videoId)).toBe(false);
	});

	it("keeps database rows and storage intact when retiring the worker fails", async () => {
		const database = databaseFixture();
		const storage = await storageFixture([[outputKey, "verified-video"]]);
		database.beforePrepareDelete(async () => {
			throw new Error("Job retirement unavailable");
		});
		expect(Exit.isFailure(await runVideoOperation("delete"))).toBe(true);
		expect(database.rows.has(videoId)).toBe(true);
		expect(database.mutations).toEqual([]);
		expect(storage.requests).toEqual([]);
	});

	it("does not report successful deletion when S3 rejects a retained source object", async () => {
		const database = databaseFixture();
		const retainedKey = `${prefix}.recording/sources/generation/snapshot/video/0.m4s`;
		const storage = await storageFixture([
			[outputKey, "verified-video"],
			[retainedKey, "retained-fragment"],
		]);
		storage.deniedDeletes.add(retainedKey);
		expect(Exit.isFailure(await runVideoOperation("delete"))).toBe(true);
		expect(storage.objects.get(retainedKey)).toBe("retained-fragment");
		expect(database.rows.has(videoId)).toBe(true);
		expect(database.jobs.get(videoId)).toMatchObject({
			state: "source-blocked",
			errorCode: "video-deleting",
		});
		for (const shares of database.shares.values()) {
			expect([...shares.values()].map((share) => share.videoId)).toEqual([
				videoId,
				videoId,
				"other-video",
			]);
		}
		storage.deniedDeletes.clear();
		expect(Exit.isSuccess(await runVideoOperation("delete"))).toBe(true);
		expect(database.rows.has(videoId)).toBe(false);
		expect(database.jobs.has(videoId)).toBe(false);
		expect(storage.objects.has(retainedKey)).toBe(false);
	});

	it("does not leave a published duplicate when copying its output fails", async () => {
		const database = databaseFixture();
		const storage = await storageFixture([
			[outputKey, "verified-video"],
			[thumbnailKey, "verified-thumbnail"],
			[previewKey, "verified-preview"],
		]);
		storage.failCopy(`${newPrefix}result.mp4`);
		expect(Exit.isFailure(await runVideoOperation("duplicate"))).toBe(true);
		expect(database.rows.has("duplicate-video")).toBe(false);
		expect(database.rows.has(videoId)).toBe(true);
		expect(storage.objects.get(outputKey)).toBe("verified-video");
	});

	it("returns the copy failure without publishing when rollback cleanup also fails", async () => {
		const database = databaseFixture();
		const storage = await storageFixture([
			[outputKey, "verified-video"],
			[thumbnailKey, "verified-thumbnail"],
		]);
		storage.failCopy(`${newPrefix}screenshot/screen-capture.jpg`);
		storage.deniedDeletes.add(`${newPrefix}result.mp4`);
		const result = await runVideoOperation("duplicate");
		expect(Exit.isFailure(result)).toBe(true);
		expect(database.rows.has("duplicate-video")).toBe(false);
		expect(database.rows.has(videoId)).toBe(true);
		expect(storage.requests).toContainEqual(
			expect.objectContaining({ operation: "delete" }),
		);
		expect(storage.objects.get(`${newPrefix}result.mp4`)).toBe(
			"verified-video",
		);
		expect(storage.objects.get(outputKey)).toBe("verified-video");
	});

	it("keeps cloned media when video creation committed but its response was lost", async () => {
		const database = databaseFixture(
			recording({ type: "desktopMP4", outputKey }),
		);
		const storage = await storageFixture([[outputKey, "verified-video"]]);
		database.loseNextCreateResponse();
		expect(Exit.isFailure(await runVideoOperation("duplicate"))).toBe(true);
		expect(database.rows.has("duplicate-video")).toBe(true);
		expect(storage.objects.get(`${newPrefix}result.mp4`)).toBe(
			"verified-video",
		);
		expect(
			storage.requests.filter(({ operation }) => operation === "delete"),
		).toEqual([]);
	});

	it("does not leave a partial duplicate when a later object listing fails", async () => {
		const database = databaseFixture();
		const retained = Array.from(
			{ length: 1100 },
			(_, index) =>
				[
					`${prefix}.recording/sources/generation/snapshot/video/${String(index).padStart(5, "0")}.m4s`,
					"fragment",
				] as const,
		);
		const storage = await storageFixture([
			...retained,
			[outputKey, "verified-video"],
			[thumbnailKey, "verified-thumbnail"],
			[previewKey, "verified-preview"],
		]);
		const firstPageEnd = [...storage.objects.keys()].sort().at(999);
		if (!firstPageEnd) throw new Error("Missing pagination boundary");
		storage.failList(firstPageEnd);
		expect(Exit.isFailure(await runVideoOperation("duplicate"))).toBe(true);
		expect(database.rows.has("duplicate-video")).toBe(false);
		expect(database.rows.has(videoId)).toBe(true);
		expect(
			[...storage.objects.keys()].some((key) => key.startsWith(newPrefix)),
		).toBe(false);
	});

	it("pins single-copy source identities and permits empty ancillary objects", async () => {
		databaseFixture(recording({ type: "desktopMP4", outputKey }));
		const ancillaryKey = `${prefix}empty.vtt`;
		const storage = await storageFixture([
			[outputKey, "verified-video"],
			[ancillaryKey, ""],
		]);
		expect(Exit.isSuccess(await runVideoOperation("duplicate"))).toBe(true);
		expect(storage.copyInputs).toHaveLength(2);
		expect(storage.copyInputs).toContainEqual(
			expect.objectContaining({
				CopySource: `test-bucket/${ancillaryKey}`,
				CopySourceIfMatch: storage.identities.get(ancillaryKey),
			}),
		);
		expect(storage.objects.get(`${newPrefix}empty.vtt`)).toBe("");
		expect(storage.sizes.get(`${newPrefix}empty.vtt`)).toBe(0);
	});

	it("copies an 8 GiB recording in complete conditional server-side ranges", async () => {
		const database = databaseFixture(
			recording({ type: "desktopMP4", outputKey }),
		);
		const storage = await storageFixture([[outputKey, "large-verified-video"]]);
		const fileSize = 8 * 1024 ** 3;
		storage.sizes.set(outputKey, fileSize);
		const sourceIdentity = storage.identities.get(outputKey);
		expect(Exit.isSuccess(await runVideoOperation("duplicate"))).toBe(true);
		expect(storage.copyInputs).toHaveLength(0);
		expect(storage.createInputs).toEqual([
			expect.objectContaining({
				Key: `${newPrefix}result.mp4`,
				ContentType: "video/mp4",
				Metadata: { recording: "retained" },
			}),
		]);
		expect(storage.partInputs).toHaveLength(64);
		let position = 0;
		for (const [index, part] of storage.partInputs.entries()) {
			expect(part.CopySourceIfMatch).toBe(sourceIdentity);
			expect(part.CopySource).toBe(`test-bucket/${outputKey}`);
			expect(part.PartNumber).toBe(index + 1);
			const range = /^bytes=(\d+)-(\d+)$/.exec(part.CopySourceRange ?? "");
			if (!range) throw new Error("Missing multipart range");
			expect(Number(range[1])).toBe(position);
			position = Number(range[2]) + 1;
		}
		expect(position).toBe(fileSize);
		expect(storage.completeInputs).toEqual([
			expect.objectContaining({
				IfNoneMatch: "*",
				MultipartUpload: {
					Parts: Array.from({ length: 64 }, (_, index) => ({
						PartNumber: index + 1,
						ETag: `"part-${index + 1}"`,
					})),
				},
			}),
		]);
		expect(storage.sizes.get(`${newPrefix}result.mp4`)).toBe(fileSize);
		expect(storage.identities.get(`${newPrefix}result.mp4`)).not.toBe(
			sourceIdentity,
		);
		expect(database.rows.has("duplicate-video")).toBe(true);
		expect(storage.uploads.size).toBe(0);
	});

	it("aborts a failed multipart copy without publishing or deleting the original", async () => {
		const database = databaseFixture(
			recording({ type: "desktopMP4", outputKey }),
		);
		const storage = await storageFixture([[outputKey, "large-verified-video"]]);
		storage.sizes.set(outputKey, 8 * 1024 ** 3);
		storage.failPart(2);
		expect(Exit.isFailure(await runVideoOperation("duplicate"))).toBe(true);
		expect(storage.completeInputs).toHaveLength(0);
		expect(
			storage.requests.filter(
				({ operation }) => operation === "multipart-abort",
			),
		).toHaveLength(1);
		expect(storage.uploads.size).toBe(0);
		expect(database.rows.has("duplicate-video")).toBe(false);
		expect(storage.objects.get(outputKey)).toBe("large-verified-video");
	});

	it.each([
		"source-changed",
		"copy-truncated",
		"copy-replaced",
		"weak-source-identity",
	])("does not publish a duplicate with %s", async (reason) => {
		const database = databaseFixture(
			recording({ type: "desktopMP4", outputKey }),
		);
		const storage = await storageFixture([[outputKey, "verified-video"]]);
		if (reason === "source-changed")
			storage.afterCopy(() =>
				storage.identities.set(outputKey, '"replacement-source"'),
			);
		else if (reason === "copy-truncated")
			storage.afterCopy(() => storage.sizes.set(`${newPrefix}result.mp4`, 1));
		else if (reason === "copy-replaced")
			storage.afterCopy(() =>
				storage.identities.set(`${newPrefix}result.mp4`, '"unexpected-output"'),
			);
		else storage.identities.set(outputKey, 'W/"weak"');
		expect(Exit.isFailure(await runVideoOperation("duplicate"))).toBe(true);
		expect(database.rows.has("duplicate-video")).toBe(false);
		expect(storage.objects.has(`${newPrefix}result.mp4`)).toBe(false);
		expect(storage.objects.get(outputKey)).toBe("verified-video");
	});

	it.each([
		{ operation: "delete" as const, kind: "missing" as const },
		{ operation: "delete" as const, kind: "repeated" as const },
		{ operation: "duplicate" as const, kind: "missing" as const },
		{ operation: "duplicate" as const, kind: "repeated" as const },
	])(
		"fails $operation safely on a $kind continuation token",
		async ({ operation, kind }) => {
			const database = databaseFixture(
				recording({ type: "desktopMP4", outputKey }),
			);
			const storage = await storageFixture([[outputKey, "verified-video"]]);
			storage.malformedPagination(kind);
			expect(Exit.isFailure(await runVideoOperation(operation))).toBe(true);
			expect(
				storage.requests.filter(({ operation }) => operation === "list"),
			).toHaveLength(kind === "missing" ? 1 : 2);
			expect(database.rows.has(videoId)).toBe(true);
			if (operation === "delete")
				expect(database.jobs.get(videoId)?.errorCode).toBe("video-deleting");
			else {
				expect(database.rows.has("duplicate-video")).toBe(false);
				expect(storage.objects.has(`${newPrefix}result.mp4`)).toBe(false);
			}
		},
	);

	it("rolls back the deletion fence if the owner changes before the fenced commit", async () => {
		const database = databaseFixture();
		const storage = await storageFixture([[outputKey, "verified-video"]]);
		database.beforePrepareDelete(async () => {
			const row = database.rows.get(videoId);
			if (!row) throw new Error("Missing video row");
			row.ownerId = "new-owner";
		});
		expect(Exit.isFailure(await runVideoOperation("delete"))).toBe(true);
		expect(database.jobs.get(videoId)?.generation).toBe("active-generation");
		expect(storage.requests).toEqual([]);
	});

	it("retains the video and deletion fence if ownership changes during cloud cleanup", async () => {
		const database = databaseFixture();
		const storage = await storageFixture([[outputKey, "verified-video"]]);
		storage.beforeDelete(() => {
			const row = database.rows.get(videoId);
			if (!row) throw new Error("Missing video row");
			row.ownerId = "new-owner";
		});
		expect(Exit.isFailure(await runVideoOperation("delete"))).toBe(true);
		expect(database.rows.get(videoId)?.ownerId).toBe("new-owner");
		expect(database.jobs.get(videoId)?.errorCode).toBe("video-deleting");
		expect(
			database.mutations.filter(({ operation }) => operation === "delete"),
		).toEqual([]);
	});

	it("deletes every retained source page after fencing the worker and removes the row last", async () => {
		const database = databaseFixture();
		const retained = Array.from(
			{ length: 1100 },
			(_, index) =>
				[
					`${prefix}.recording/sources/generation/snapshot/video/${String(index).padStart(5, "0")}.m4s`,
					"fragment",
				] as const,
		);
		const storage = await storageFixture([
			...retained,
			[outputKey, "verified-output"],
			[`${prefix}comments/comment/attachment.mp4`, "comment-attachment"],
			["other-user/other-video/result.mp4", "unrelated"],
		]);
		storage.beforeDelete(() => {
			expect(database.rows.has(videoId)).toBe(true);
			expect(database.jobs.get(videoId)?.errorCode).toBe("video-deleting");
		});
		const result = await runVideoOperation("delete");
		expect(Exit.isSuccess(result)).toBe(true);
		expect(database.rows.has(videoId)).toBe(false);
		expect(database.events.slice(0, 3)).toEqual([
			"job-fence-request",
			"job-delete-request",
			"job-delete-complete",
		]);
		expect(storage.objects).toEqual(
			new Map([["other-user/other-video/result.mp4", "unrelated"]]),
		);
		expect(
			storage.requests.filter(({ operation }) => operation === "list"),
		).toHaveLength(2);
		const deleted = storage.requests.filter(
			({ operation }) => operation === "delete",
		);
		expect(deleted.map(({ keys }) => keys?.length)).toEqual([1000, 102]);
	});

	it.each([
		{ suffix: "segments/manifest.json", status: 403 },
		{ suffix: "segments/manifest.json", status: 503 },
		{
			suffix: ".recording/sources/generation/snapshot/pages/0.json",
			status: 403,
		},
		{
			suffix: ".recording/sources/generation/snapshot/pages/0.json",
			status: 503,
		},
	])(
		"preserves a $status Drive read failure for $suffix without recovery or index changes",
		async ({ suffix, status }) => {
			const drive = await driveFixture();
			const original = drive.records.get(outputKey);
			if (!original) throw new Error("Missing indexed Drive object");
			const key = `${prefix}${suffix}`;
			drive.records.set(key, { ...original, objectKey: key });
			const error = new StorageDomain.StorageError({
				cause: new GoogleDriveRequestError(status, "fixture read failure"),
			});
			mocks.driveText.mockReturnValue(Effect.fail(error));
			const result = await Effect.runPromiseExit(drive.access.getObject(key));
			if (Exit.isSuccess(result))
				throw new Error("Transient Drive failure was not propagated");
			expect(Option.getOrThrow(Cause.failureOption(result.cause))).toBe(error);
			expect(drive.records.get(key)?.providerObjectId).toBe("original-file");
			expect(mocks.driveFind).not.toHaveBeenCalled();
			expect(drive.updateIndex).not.toHaveBeenCalled();
		},
	);

	it.each([403, 503])(
		"does not replace the Drive index after a %s metadata failure",
		async (status) => {
			const drive = await driveFixture();
			const error = new StorageDomain.StorageError({
				cause: new GoogleDriveRequestError(status, "fixture metadata failure"),
			});
			mocks.driveMetadata.mockReturnValue(Effect.fail(error));
			const result = await Effect.runPromiseExit(
				drive.access.headObject(outputKey),
			);
			if (Exit.isSuccess(result))
				throw new Error("Transient Drive metadata failure was not propagated");
			expect(Option.getOrThrow(Cause.failureOption(result.cause))).toBe(error);
			expect(mocks.driveFind).not.toHaveBeenCalled();
			expect(drive.records.get(outputKey)?.providerObjectId).toBe(
				"original-file",
			);
		},
	);

	it("keeps network and database read errors distinct from missing Drive objects", async () => {
		const drive = await driveFixture();
		const networkError = new StorageDomain.StorageError({
			cause: new Error("Network read unavailable"),
		});
		mocks.driveText.mockReturnValue(Effect.fail(networkError));
		const networkResult = await Effect.runPromiseExit(
			drive.access.getObject(outputKey),
		);
		if (Exit.isSuccess(networkResult))
			throw new Error("Network failure was not propagated");
		expect(Option.getOrThrow(Cause.failureOption(networkResult.cause))).toBe(
			networkError,
		);
		const databaseError = new DatabaseError({
			cause: new Error("Index read unavailable"),
		});
		drive.getIndex.mockReturnValue(Effect.fail(databaseError));
		const databaseResult = await Effect.runPromiseExit(
			drive.access.getObject(outputKey),
		);
		if (Exit.isSuccess(databaseResult))
			throw new Error("Database failure was not propagated");
		expect(
			Option.getOrThrow(Cause.failureOption(databaseResult.cause)).cause,
		).toBe(databaseError);
		expect(mocks.driveFind).not.toHaveBeenCalled();
		expect(drive.updateIndex).not.toHaveBeenCalled();
	});

	it("returns none for a genuinely missing Drive file with no replacement", async () => {
		const drive = await driveFixture();
		mocks.driveText.mockReturnValue(
			Effect.fail(
				new StorageDomain.StorageError({
					cause: new GoogleDriveRequestError(404, "Missing file"),
				}),
			),
		);
		expect(await Effect.runPromise(drive.access.getObject(outputKey))).toEqual(
			Option.none(),
		);
		expect(mocks.driveFind).toHaveBeenCalledTimes(1);
		expect(drive.records.get(outputKey)?.providerObjectId).toBe(
			"original-file",
		);
		expect(drive.updateIndex).not.toHaveBeenCalled();
	});

	it("returns none for a missing index without requesting or recovering a Drive file", async () => {
		const drive = await driveFixture();
		drive.records.delete(outputKey);
		expect(await Effect.runPromise(drive.access.getObject(outputKey))).toEqual(
			Option.none(),
		);
		expect(mocks.driveText).not.toHaveBeenCalled();
		expect(mocks.driveFind).not.toHaveBeenCalled();
	});

	it.each(["index", "provider"])(
		"returns a typed missing-object error from Drive HEAD for an absent %s object",
		async (origin) => {
			const drive = await driveFixture();
			if (origin === "index") {
				drive.records.delete(outputKey);
			} else {
				mocks.driveMetadata.mockReturnValue(
					Effect.fail(
						new StorageDomain.StorageError({
							cause: new GoogleDriveRequestError(404, "Missing file"),
						}),
					),
				);
			}
			const result = await Effect.runPromiseExit(
				drive.access.headObject(outputKey),
			);
			if (Exit.isSuccess(result))
				throw new Error("Missing Drive metadata was not reported");
			const error = Option.getOrThrow(Cause.failureOption(result.cause));
			const cause =
				error.cause instanceof StorageDomain.StorageError
					? error.cause.cause
					: error.cause;
			expect(cause).toBeInstanceOf(GoogleDriveRequestError);
			expect(cause).toHaveProperty("status", 404);
			expect(mocks.driveFind).toHaveBeenCalledTimes(origin === "index" ? 0 : 1);
			expect(drive.updateIndex).not.toHaveBeenCalled();
		},
	);

	it("recovers an indexed 404 to the replacement file before returning its text", async () => {
		const drive = await driveFixture();
		const original = drive.records.get(outputKey);
		if (!original) throw new Error("Missing indexed Drive object");
		const metadata = { fileName: "Original recording.mp4", videoId };
		drive.records.set(outputKey, { ...original, metadata });
		const text = '{"source":"retained"}';
		mocks.driveText
			.mockReturnValueOnce(
				Effect.fail(
					new StorageDomain.StorageError({
						cause: new GoogleDriveRequestError(404, "Missing indexed file"),
					}),
				),
			)
			.mockReturnValueOnce(Effect.succeed(text));
		mocks.driveFind.mockReturnValue(
			Effect.succeed(
				Option.some({
					id: "recovered-file",
					name: "Stale Drive name.mp4",
					size: String(text.length),
					mimeType: "application/json",
				}),
			),
		);
		expect(await Effect.runPromise(drive.access.getObject(outputKey))).toEqual(
			Option.some(text),
		);
		expect(mocks.driveText.mock.calls.map((args) => args[1])).toEqual([
			"original-file",
			"recovered-file",
		]);
		expect(drive.records.get(outputKey)?.providerObjectId).toBe(
			"recovered-file",
		);
		expect(drive.records.get(outputKey)?.metadata).toEqual(metadata);
		expect(drive.updateIndex).toHaveBeenCalledTimes(1);
	});

	it("propagates a provider failure while looking for a replacement of an indexed 404", async () => {
		const drive = await driveFixture();
		mocks.driveText.mockReturnValue(
			Effect.fail(
				new StorageDomain.StorageError({
					cause: new GoogleDriveRequestError(404, "Missing indexed file"),
				}),
			),
		);
		const error = new StorageDomain.StorageError({
			cause: new GoogleDriveRequestError(503, "Recovery unavailable"),
		});
		mocks.driveFind.mockReturnValue(Effect.fail(error));
		const result = await Effect.runPromiseExit(
			drive.access.getObject(outputKey),
		);
		if (Exit.isSuccess(result))
			throw new Error("Recovery failure was not propagated");
		expect(Option.getOrThrow(Cause.failureOption(result.cause))).toBe(error);
		expect(drive.records.get(outputKey)?.providerObjectId).toBe(
			"original-file",
		);
		expect(drive.updateIndex).not.toHaveBeenCalled();
	});

	it.each([403, 503])(
		"preserves the Drive object index when provider deletion returns %s",
		async (status) => {
			const drive = await driveFixture();
			mocks.driveDelete.mockReturnValue(
				Effect.fail(
					new StorageDomain.StorageError({
						cause: new GoogleDriveRequestError(
							status,
							"fixture provider failure",
						),
					}),
				),
			);
			const result = await Effect.runPromiseExit(
				drive.access.deleteObjects([{ Key: outputKey }]),
			);
			expect(Exit.isFailure(result)).toBe(true);
			expect(drive.records.get(outputKey)?.providerObjectId).toBe(
				"original-file",
			);
			expect(drive.deleteIndex).not.toHaveBeenCalled();
		},
	);

	it("clears a genuinely missing Drive object and makes repeated deletion idempotent", async () => {
		const drive = await driveFixture();
		mocks.driveDelete.mockReturnValue(
			Effect.fail(
				new StorageDomain.StorageError({
					cause: new GoogleDriveRequestError(404, "missing fixture file"),
				}),
			),
		);
		await Effect.runPromise(drive.access.deleteObject(outputKey));
		await Effect.runPromise(drive.access.deleteObject(outputKey));
		expect(drive.records.has(outputKey)).toBe(false);
		expect(drive.deleteIndex).toHaveBeenCalledExactlyOnceWith(
			drive.integrationId,
			outputKey,
			"original-file",
		);
		expect(mocks.driveDelete).toHaveBeenCalledTimes(1);
	});

	it("retains the Drive index until the provider confirms deletion", async () => {
		const drive = await driveFixture();
		let release: (() => void) | undefined;
		const gate = new Promise<void>((resolve) => {
			release = resolve;
		});
		mocks.driveDelete.mockReturnValue(Effect.promise(() => gate));
		const pending = Effect.runPromise(drive.access.deleteObject(outputKey));
		await vi.waitFor(() => expect(mocks.driveDelete).toHaveBeenCalledTimes(1));
		expect(drive.records.has(outputKey)).toBe(true);
		expect(drive.deleteIndex).not.toHaveBeenCalled();
		if (!release) throw new Error("Missing Drive delete resolver");
		release();
		await pending;
		expect(drive.records.has(outputKey)).toBe(false);
	});

	it.each([204, 404])(
		"preserves a concurrent Drive remapping when deleting the old file returns %s",
		async (status) => {
			const drive = await driveFixture();
			const original = drive.records.get(outputKey);
			if (!original) throw new Error("Missing indexed Drive object");
			let release: (() => void) | undefined;
			const gate = new Promise<void>((resolve) => {
				release = resolve;
			});
			mocks.driveDelete.mockReturnValue(
				Effect.promise(() => gate).pipe(
					Effect.zipRight(
						status === 404
							? Effect.fail(
									new StorageDomain.StorageError({
										cause: new GoogleDriveRequestError(404, "Old file missing"),
									}),
								)
							: Effect.void,
					),
				),
			);
			const pending = Effect.runPromise(drive.access.deleteObject(outputKey));
			await vi.waitFor(() =>
				expect(mocks.driveDelete).toHaveBeenCalledTimes(1),
			);
			const replacement = {
				...original,
				providerObjectId: "new-pending-file",
				uploadStatus: "pending" as const,
			};
			drive.records.set(outputKey, replacement);
			if (!release) throw new Error("Missing Drive delete resolver");
			release();
			await pending;
			expect(drive.records.get(outputKey)).toEqual(replacement);
			expect(mocks.driveDelete).toHaveBeenCalledWith(
				expect.anything(),
				"original-file",
				expect.anything(),
			);
			expect(drive.deleteIndex).toHaveBeenCalledExactlyOnceWith(
				drive.integrationId,
				outputKey,
				"original-file",
			);
			expect(drive.deleteConditions).toHaveLength(1);
			const [condition] = drive.deleteConditions;
			if (!condition) throw new Error("Missing Drive index delete condition");
			expect(new SQLiteSyncDialect().sqlToQuery(condition).params).toEqual([
				drive.integrationId,
				expect.stringMatching(/^[a-f0-9]{64}$/),
				outputKey,
				"original-file",
			]);
		},
	);

	it("copies the published Drive object and checks both file identities after native copy", async () => {
		const drive = await driveFixture();
		await Effect.runPromise(
			drive.access.copyObjectForRecording(
				`google-drive/${prefix}result.mp4`,
				`${newPrefix}result.mp4`,
			),
		);
		expect(mocks.driveCopy).toHaveBeenCalledWith(
			expect.objectContaining({
				sourceFileId: "original-file",
				input: expect.objectContaining({
					key: `${newPrefix}result.mp4`,
					contentType: "video/mp4",
				}),
			}),
		);
		expect(mocks.driveMetadata.mock.calls.map((args) => args[1])).toEqual([
			"original-file",
			"original-file",
			"copied-file",
		]);
		expect(drive.records.get(`${newPrefix}result.mp4`)?.providerObjectId).toBe(
			"copied-file",
		);
	});

	it("allows native Drive copies to change metadata versions without changing bytes", async () => {
		const drive = await driveFixture();
		const nativeCopy = mocks.driveCopy.getMockImplementation();
		if (!nativeCopy) throw new Error("Missing native Drive copy fixture");
		mocks.driveCopy.mockImplementation(
			(input: Parameters<typeof copyGoogleDriveFile>[0]) =>
				nativeCopy(input).pipe(
					Effect.tap(() =>
						Effect.sync(() => {
							for (const file of drive.files.values()) file.version = "6";
						}),
					),
				),
		);
		await Effect.runPromise(
			drive.access.copyObjectForRecording(
				`google-drive/${outputKey}`,
				`${newPrefix}result.mp4`,
			),
		);
		expect(drive.records.get(`${newPrefix}result.mp4`)?.providerObjectId).toBe(
			"copied-file",
		);
	});

	it.each([
		"source-checksum",
		"destination-checksum",
		"destination-size",
	] as const)(
		"rejects a Drive copy when %s changes during readback",
		async (change) => {
			const drive = await driveFixture();
			const nativeCopy = mocks.driveCopy.getMockImplementation();
			if (!nativeCopy) throw new Error("Missing native Drive copy fixture");
			mocks.driveCopy.mockImplementation(
				(input: Parameters<typeof copyGoogleDriveFile>[0]) =>
					nativeCopy(input).pipe(
						Effect.tap(() =>
							Effect.sync(() => {
								if (change === "source-checksum") {
									const original = drive.files.get("original-file");
									if (!original)
										throw new Error("Missing original Drive fixture");
									original.sha256Checksum = "b".repeat(64);
								} else {
									const destination = drive.files.get("copied-file");
									if (!destination)
										throw new Error("Missing copied Drive fixture");
									if (change === "destination-size") destination.size = "9";
									else destination.sha256Checksum = "b".repeat(64);
								}
							}),
						),
					),
			);
			const result = await Effect.runPromiseExit(
				drive.access.copyObjectForRecording(
					`google-drive/${outputKey}`,
					`${newPrefix}result.mp4`,
				),
			);
			expect(Exit.isFailure(result)).toBe(true);
			expect(drive.records.has(outputKey)).toBe(true);
		},
	);
});
