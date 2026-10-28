import { createHash, randomUUID } from "node:crypto";
import { createCloudflareDb } from "@cap/database/cloudflare";
import {
	createD1BridgeBinding,
	handleD1BridgeRequest,
} from "@cap/database/cloudflare/bridge";
import * as Db from "@cap/database/cloudflare/schema";
import {
	decryptEditTranscriptObject,
	encryptEditTranscriptObject,
} from "@cap/database/transcript-encryption";
import {
	Comment,
	Folder,
	Organisation,
	S3Bucket,
	User,
	Video,
} from "@cap/web-domain";
import type { HttpApi } from "@effect/platform";
import { eq } from "drizzle-orm";
import type { Layer as EffectLayer } from "effect";
import { Effect, Option } from "effect";
import { NextRequest } from "next/server";
import {
	afterAll,
	afterEach,
	beforeAll,
	beforeEach,
	expect,
	it,
	vi,
} from "vitest";
import type { ContentTransferPayload } from "@/lib/content-transfer";
import { encodeContentTransferPayload } from "@/lib/content-transfer-payload";
import { createTestDatabase } from "../../../../packages/database/cloudflare/test-runtime";

const state = vi.hoisted(() => ({
	database: undefined as ReturnType<typeof createCloudflareDb> | undefined,
	access: vi.fn(),
	user: vi.fn(),
	objects: new Map<string, string>(),
	onCopy: undefined as (() => Promise<void>) | undefined,
	badHeadKey: undefined as string | undefined,
}));
vi.mock("server-only", () => ({}));
vi.mock("@cap/database/auth/session", () => ({ getCurrentUser: state.user }));
vi.mock("@cap/database/emails/config", () => ({ sendEmail: vi.fn() }));
vi.mock("@cap/database/cloudflare/application", () => ({
	db: () => {
		if (!state.database) throw Error("Missing fixture");
		return state.database;
	},
}));
vi.mock("@cap/env", () => ({
	buildEnv: {
		NEXT_PUBLIC_IS_CAP: "false",
		NEXT_PUBLIC_WEB_URL: "https://cap.test",
	},
	serverEnv: () => ({
		MEDIA_SERVER_WEBHOOK_SECRET: "media-secret",
		NEXTAUTH_SECRET: "synthetic-transfer-test-key",
		WEB_URL: "https://cap.test",
	}),
}));
vi.mock("@cap/web-backend/src/Storage/index", () => ({
	Storage: { getAccessForVideo: state.access },
}));
vi.mock("@/lib/workflow-runtime", () => ({
	runWorkflowPromise: Effect.runPromise,
}));
vi.mock("@/lib/sync-video-storage-names", () => ({
	enqueueVideoStorageNameSync: vi.fn(async () => undefined),
}));
vi.mock("workflow", () => ({ FatalError: class FatalError extends Error {} }));

import { reassignLoomImport } from "@/lib/loom-import-reassign";
import { transferOrganizationContentWorkflow } from "@/workflows/transfer-organization-content";

vi.mock("@/lib/server", async () => {
	const { HttpApiBuilder, HttpServer } = await import("@effect/platform"),
		{ Layer } = await import("effect");
	return {
		runPromise: Effect.runPromise,
		apiToHandler: (api: EffectLayer.Layer<HttpApi.Api>) => {
			const { handler } = HttpApiBuilder.toWebHandler(
				Layer.mergeAll(api, HttpServer.layerContext),
			);
			return (request: Request) => handler(request);
		},
	};
});

import { POST as reassignHttp } from "@/app/api/internal/loom-imports/reassign/route";

let runtime: Awaited<ReturnType<typeof createTestDatabase>>,
	beforePublication: (() => Promise<void>) | undefined,
	loseResponse = false,
	loseCompletionResponse = false,
	sequence = 0;
const identity = (body: string) =>
	`"${createHash("sha256").update(body).digest("hex")}"`;
const uploads = new Map<string, { key: string; parts: Map<number, Buffer> }>();
let uploadSequence = 0;
const bucket = {
	getInternalSignedObjectUrl: (key: string) =>
		Effect.succeed(`https://fixture-storage.test/${encodeURIComponent(key)}`),
	multipart: {
		create: (key: string) =>
			Effect.sync(() => {
				const UploadId = `copy${++uploadSequence}`;
				uploads.set(UploadId, { key, parts: new Map() });
				return { UploadId };
			}),
		copyPart: (
			_key: string,
			uploadId: string,
			number: number,
			args: {
				CopySource: string;
				CopySourceIfMatch: string;
				CopySourceRange: string;
			},
		) =>
			Effect.tryPromise(async () => {
				const upload = uploads.get(uploadId);
				if (!upload) throw Error("Missing upload");
				const key = args.CopySource.slice("test-bucket/".length)
					.split("/")
					.map(decodeURIComponent)
					.join("/");
				const body = state.objects.get(key);
				if (body === undefined || identity(body) !== args.CopySourceIfMatch)
					throw Error("Copy source changed");
				const match = /^bytes=(\d+)-(\d+)$/.exec(args.CopySourceRange);
				if (!match) throw Error("Invalid copy range");
				const bytes = Buffer.from(body).subarray(
					Number(match[1]),
					Number(match[2]) + 1,
				);
				upload.parts.set(number, bytes);
				if (state.onCopy) {
					const hook = state.onCopy;
					state.onCopy = undefined;
					await hook();
				}
				return { CopyPartResult: { ETag: identity(bytes.toString()) } };
			}),
		complete: (
			key: string,
			uploadId: string,
			options: { IfNoneMatch?: string },
		) =>
			Effect.try(() => {
				expect(options.IfNoneMatch).toBe("*");
				if (state.objects.has(key)) throw Error("Precondition failed");
				const upload = uploads.get(uploadId);
				if (!upload || upload.key !== key)
					throw Error("Invalid upload context");
				const body = Buffer.concat(
					[...upload.parts].sort(([a], [b]) => a - b).map(([, value]) => value),
				).toString();
				state.objects.set(key, body);
				uploads.delete(uploadId);
				return { ETag: identity(body) };
			}),
		abort: (_key: string, uploadId: string) =>
			Effect.sync(() => {
				uploads.delete(uploadId);
			}),
	},
	provider: "s3",
	bucketName: "test-bucket",
	listObjects: ({
		prefix,
		maxKeys,
		continuationToken,
	}: {
		prefix: string;
		maxKeys: number;
		continuationToken?: string;
	}) =>
		Effect.sync(() => {
			const keys = [...state.objects.keys()]
					.filter((key) => key.startsWith(prefix))
					.sort(),
				offset = Number(continuationToken ?? 0),
				page = keys.slice(offset, offset + maxKeys);
			return {
				Contents: page.map((Key) => ({
					Key,
					Size: Buffer.byteLength(state.objects.get(Key) ?? ""),
				})),
				IsTruncated: offset + maxKeys < keys.length,
				NextContinuationToken: String(offset + maxKeys),
			};
		}),
	headObject: (key: string) =>
		Effect.try(() => {
			const body = state.objects.get(key);
			if (body === undefined)
				throw Object.assign(Error("Not found"), { name: "NotFound" });
			return {
				ContentLength:
					Buffer.byteLength(body) + (state.badHeadKey === key ? 1 : 0),
				ETag: identity(body),
			};
		}),
	getObject: (key: string) =>
		Effect.sync(() => Option.fromNullable(state.objects.get(key))),
	putObject: (key: string, body: string) =>
		Effect.sync(() => {
			state.objects.set(key, body);
		}),
	copyObjectForRecording: (source: string, key: string) =>
		Effect.tryPromise(async () => {
			const body = state.objects.get(source.slice("test-bucket/".length));
			if (body === undefined) throw Error("Missing source");
			state.objects.set(key, body);
			if (state.onCopy) {
				const hook = state.onCopy;
				state.onCopy = undefined;
				await hook();
			}
			return identity(body);
		}),
	deleteObjects: (objects: { Key: string }[]) =>
		Effect.sync(() => {
			for (const object of objects) state.objects.delete(object.Key);
		}),
};
beforeAll(async () => {
	runtime = await createTestDatabase();
	state.database = createCloudflareDb(
		createD1BridgeBinding({
			fetch: async (request) => {
				const payload = (await request.clone().json()) as {
					operation: string;
					statements?: { sql: string; params?: unknown[] }[];
				};
				const publication =
					payload.operation === "batch" &&
					payload.statements?.some(
						(statement) =>
							statement.sql.startsWith('update "videos"') &&
							statement.sql.includes('set "ownerId"'),
					);
				if (publication && beforePublication) {
					const hook = beforePublication;
					beforePublication = undefined;
					await hook();
				}
				const completion =
					payload.operation === "batch" &&
					payload.statements?.some(
						(statement) =>
							statement.sql.startsWith('update "agent_api_operations"') &&
							statement.params?.includes("succeeded"),
					);
				const response = await handleD1BridgeRequest(request, runtime.binding);
				if (completion && loseCompletionResponse && response.ok) {
					loseCompletionResponse = false;
					throw Error("Completion response lost");
				}
				if (publication && loseResponse && response.ok) {
					loseResponse = false;
					loseCompletionResponse = false;
					throw Error("Publication response lost");
				}
				return response;
			},
		}),
	);
}, 60000);
afterEach(() => {
	vi.unstubAllGlobals();
	vi.unstubAllEnvs();
});
beforeEach(() => {
	uploads.clear();
	state.badHeadKey = undefined;
	vi.stubGlobal(
		"fetch",
		vi.fn(
			async (input: string) =>
				new Response(
					state.objects.get(
						decodeURIComponent(new URL(input).pathname.slice(1)),
					) ?? null,
				),
		),
	);
	state.access.mockImplementation(
		(video: { id: Video.VideoId; ownerId: User.UserId }) =>
			Effect.tryPromise(async () => {
				const [row] = await runtime.database
					.select({ ownerId: Db.videos.ownerId })
					.from(Db.videos)
					.where(eq(Db.videos.id, video.id));
				if (row?.ownerId !== video.ownerId)
					throw Error("Storage video ownership mismatch");
				return [bucket];
			}),
	);
});
afterAll(async () => runtime?.dispose());
async function fixture() {
	const s = String(++sequence),
		ownerId = User.UserId.make(`wo${s.padStart(13, "0")}`),
		targetId = User.UserId.make(`wt${s.padStart(13, "0")}`),
		orgId = Organisation.OrganisationId.make(`wg${s.padStart(13, "0")}`),
		videoId = Video.VideoId.make(`wv${s.padStart(13, "0")}`),
		folderId = Folder.FolderId.make(`wf${s.padStart(13, "0")}`),
		destinationId = Folder.FolderId.make(`wd${s.padStart(13, "0")}`),
		commentId = Comment.CommentId.make(`wc${s.padStart(13, "0")}`),
		membershipId = `ws${s.padStart(13, "0")}`,
		operationId = `wp${s.padStart(13, "0")}`,
		sourcePrefix = `${ownerId}/${videoId}/`,
		targetPrefix = `${targetId}/${videoId}/`,
		pointerId = "25bb8b62-de0f-4f1d-a943-c03f76dbe4fc";
	await runtime.database.insert(Db.users).values([
		{
			id: ownerId,
			email: `${s}owner@workflow.test`,
			activeOrganizationId: orgId,
		},
		{
			id: targetId,
			email: `${s}target@workflow.test`,
			activeOrganizationId: orgId,
		},
	]);
	await runtime.database
		.insert(Db.organizations)
		.values({ id: orgId, ownerId, name: "Transfer" });
	await runtime.database.insert(Db.organizationMembers).values({
		id: `wtm${s}`,
		organizationId: orgId,
		userId: targetId,
		role: "member",
	});
	await runtime.database.insert(Db.folders).values({
		id: folderId,
		organizationId: orgId,
		createdById: ownerId,
		spaceId: orgId,
		name: "Transfer folder",
	});
	const vtt = "WEBVTT\n\n00:00:01.000 --> 00:00:02.000\nWords\n",
		words = JSON.stringify({
			version: 3,
			speechModelUsed: "synthetic",
			durationMs: 25000,
			languageCode: "en",
			words: [
				{
					id: "word",
					text: "original",
					startMs: 6000,
					endMs: 6500,
					confidence: 1,
					speaker: null,
					channel: null,
				},
			],
		});
	const outputKey = `${sourcePrefix}.recording/outputs/generation/result.mp4`,
		thumbnailKey = `${sourcePrefix}.recording/outputs/generation/screenshot.jpg`,
		originalKey = `${sourcePrefix}source/original.mp4`,
		mediaKey = `${sourcePrefix}comments/comment.webm`,
		mediaThumbnailKey = `${sourcePrefix}comments/thumbnail.jpg`;
	await runtime.database.insert(Db.videos).values({
		id: videoId,
		ownerId,
		orgId,
		name: "Edited recording",
		duration: 10,
		transcriptionStatus: "COMPLETE",
		source: { type: "webMP4", outputKey, thumbnailKey },
		metadata: {
			summary: "Keep this summary",
			aiGenerationStatus: "QUEUED",
			aiGenerationRun: {
				id: "old-ai",
				requestedAt: new Date().toISOString(),
				mediaRevision: "old",
				transcriptId: pointerId,
				dispatch: "accepted",
			},
			transcriptPublication: {
				version: 1,
				id: pointerId,
				vtt: true,
				edit: true,
				revision: createHash("sha256").update(vtt).digest("hex"),
			},
			transcriptionRun: {
				id: "old-run",
				sourceRevision: "old",
				requestedAt: new Date().toISOString(),
				dispatch: "accepted",
			},
		},
	});
	await runtime.database.insert(Db.videoEdits).values({
		videoId,
		sourceKey: originalKey,
		editSpec: {
			version: 1,
			sourceDuration: 25,
			keepRanges: [{ start: 5, end: 15 }],
		},
	});
	await runtime.database.insert(Db.comments).values({
		id: commentId,
		videoId,
		authorId: ownerId,
		type: "video",
		content: "Media",
		mediaKey,
		mediaMeta: { thumbnailKey: mediaThumbnailKey, mime: "video/webm" },
	});
	await runtime.database.insert(Db.sharedVideos).values({
		id: membershipId,
		videoId,
		organizationId: orgId,
		folderId,
		sharedByUserId: ownerId,
	});
	for (const key of [
		outputKey,
		thumbnailKey,
		originalKey,
		mediaKey,
		mediaThumbnailKey,
	])
		state.objects.set(key, `bytes:${key}`);
	state.objects.set(
		`${sourcePrefix}.transcripts/${pointerId}/transcription.vtt`,
		vtt,
	);
	state.objects.set(
		`${sourcePrefix}.transcripts/${pointerId}/transcription.edit.v3.json`,
		encryptEditTranscriptObject(words, ownerId, videoId),
	);
	state.objects.set(
		`${sourcePrefix}.transcripts/old/transcription.edit.v3.json`,
		"Historical private words",
	);
	state.objects.set(
		`${sourcePrefix}transcription.edit.v3.json`,
		"Legacy private words",
	);
	const payload: ContentTransferPayload = {
		version: 1,
		organizationId: orgId,
		requestedByUserId: ownerId,
		source: { type: "organization" },
		sourceRootFolderId: folderId,
		sourceFolderIds: [folderId],
		targetUserId: targetId,
		targetEmail: `${s}target@workflow.test`,
		folderPlan: [
			{
				sourceFolderId: folderId,
				sourceParentId: null,
				sourcePublic: false,
				destinationFolderId: destinationId,
				destinationParentId: null,
				name: "Transfer folder",
				color: "normal",
				create: true,
			},
		],
		videoPlan: [
			{
				videoId,
				name: "Edited recording",
				sourceOwnerId: ownerId,
				sourceMembershipId: membershipId,
				sourceFolderId: folderId,
				destinationFolderId: destinationId,
				bucketId: null,
				storageIntegrationId: null,
				sourceUploadPhase: null,
			},
		],
		createdAt: new Date().toISOString(),
	};
	await runtime.database.insert(Db.agentApiOperations).values({
		id: operationId,
		userId: ownerId,
		resourceId: orgId,
		kind: "transfer_org_content",
		state: "queued",
		payload: sequence === 1 ? encodeContentTransferPayload(payload) : payload,
	});
	state.onCopy = undefined;
	beforePublication = undefined;
	loseResponse = false;
	return {
		ownerId,
		targetId,
		orgId,
		videoId,
		folderId,
		destinationId,
		commentId,
		membershipId,
		operationId,
		payload,
		sourcePrefix,
		targetPrefix,
		outputKey,
		originalKey,
		mediaKey,
		words,
		pointerId,
	};
}
async function video(f: Awaited<ReturnType<typeof fixture>>) {
	const [row] = await runtime.database
		.select()
		.from(Db.videos)
		.where(eq(Db.videos.id, f.videoId));
	if (!row) throw Error("Missing video");
	return row;
}
it("transfers the immutable editing base with its existing original timeline", async () => {
	const f = await fixture();
	const current = await video(f);
	const editingBase = {
		version: 1 as const,
		id: randomUUID(),
		sourceKey: `${f.sourcePrefix}.recording/outputs/replacement/result.mp4`,
		duration: 25,
	};
	state.objects.set(editingBase.sourceKey, "new editing original");
	await runtime.database.batch([
		runtime.database
			.update(Db.videos)
			.set({ metadata: { ...current.metadata, editingBase } })
			.where(eq(Db.videos.id, f.videoId)),
		runtime.database
			.update(Db.videoEdits)
			.set({ sourceKey: editingBase.sourceKey })
			.where(eq(Db.videoEdits.videoId, f.videoId)),
	]);
	await transferOrganizationContentWorkflow({ operationId: f.operationId });
	const row = await video(f);
	const targetKey = editingBase.sourceKey.replace(
		f.sourcePrefix,
		f.targetPrefix,
	);
	expect(row.metadata?.editingBase).toEqual({
		...editingBase,
		sourceKey: targetKey,
	});
	expect(
		(
			await runtime.database
				.select()
				.from(Db.videoEdits)
				.where(eq(Db.videoEdits.videoId, f.videoId))
		)[0]?.sourceKey,
	).toBe(targetKey);
	expect(state.objects.get(targetKey)).toBe("new editing original");
	expect(state.objects.get(editingBase.sourceKey)).toBe("new editing original");
});

it("atomically transfers media references and freshly encrypted original transcript words", async () => {
	const f = await fixture();
	await transferOrganizationContentWorkflow({ operationId: f.operationId });
	const row = await video(f);
	expect(row.ownerId).toBe(f.targetId);
	expect(row.folderId).toBe(f.destinationId);
	expect(row.source).toMatchObject({
		outputKey: f.outputKey.replace(f.sourcePrefix, f.targetPrefix),
	});
	expect(row.metadata?.summary).toBe("Keep this summary");
	expect(row.metadata?.aiGenerationStatus).toBeUndefined();
	expect(row.metadata?.aiGenerationRun).toBeUndefined();
	expect(row.metadata?.transcriptionRun).toBeUndefined();
	const pointer = row.metadata?.transcriptPublication;
	if (!pointer) throw Error("Missing pointer");
	expect(pointer.id).not.toBe(f.pointerId);
	const encrypted = state.objects.get(
		`${f.targetPrefix}.transcripts/${pointer.id}/transcription.edit.v3.json`,
	);
	if (!encrypted) throw Error("Missing target words");
	expect(decryptEditTranscriptObject(encrypted, f.targetId, f.videoId)).toBe(
		f.words,
	);
	expect(
		decryptEditTranscriptObject(encrypted, f.ownerId, f.videoId),
	).toBeNull();
	expect(
		[...state.objects.keys()].some((key) => key.startsWith(f.sourcePrefix)),
	).toBe(true);
	expect(state.objects.has(`${f.targetPrefix}transcription.edit.v3.json`)).toBe(
		false,
	);
	expect(
		state.objects.has(
			`${f.targetPrefix}.transcripts/old/transcription.edit.v3.json`,
		),
	).toBe(false);
	const [edit] = await runtime.database
		.select()
		.from(Db.videoEdits)
		.where(eq(Db.videoEdits.videoId, f.videoId));
	expect(edit?.sourceKey).toBe(
		f.originalKey.replace(f.sourcePrefix, f.targetPrefix),
	);
	const [comment] = await runtime.database
		.select()
		.from(Db.comments)
		.where(eq(Db.comments.id, f.commentId));
	expect(comment?.mediaKey).toBe(
		f.mediaKey.replace(f.sourcePrefix, f.targetPrefix),
	);
	expect(comment?.mediaMeta?.thumbnailKey).toBe(
		`${f.targetPrefix}comments/thumbnail.jpg`,
	);
	const [operation] = await runtime.database
		.select()
		.from(Db.agentApiOperations)
		.where(eq(Db.agentApiOperations.id, f.operationId));
	expect(operation?.state).toBe("succeeded");
});
it.each(["video", "edit", "comment"] as const)(
	"preserves source ownership after a concurrent %s change during copying",
	async (change) => {
		const f = await fixture();
		state.onCopy = async () => {
			if (change === "video")
				await runtime.database
					.update(Db.videos)
					.set({ name: "Changed" })
					.where(eq(Db.videos.id, f.videoId));
			if (change === "edit")
				await runtime.database
					.update(Db.videoEdits)
					.set({
						editSpec: {
							version: 1,
							sourceDuration: 25,
							keepRanges: [{ start: 0, end: 25 }],
						},
					})
					.where(eq(Db.videoEdits.videoId, f.videoId));
			if (change === "comment")
				await runtime.database.insert(Db.comments).values({
					id: Comment.CommentId.make("racedcomment"),
					videoId: f.videoId,
					authorId: f.ownerId,
					type: "video",
					content: "New",
					mediaKey: `${f.sourcePrefix}comments/new.webm`,
				});
		};
		await expect(
			transferOrganizationContentWorkflow({ operationId: f.operationId }),
		).rejects.toThrow(
			change === "comment"
				? "Comment media changed"
				: "changed during media copying",
		);
		expect(state.onCopy).toBeUndefined();
		expect((await video(f)).ownerId).toBe(f.ownerId);
		expect(state.objects.has(f.outputKey)).toBe(true);
		expect(
			await runtime.database
				.select()
				.from(Db.sharedVideos)
				.where(eq(Db.sharedVideos.id, f.membershipId)),
		).toHaveLength(1);
	},
);
it("rechecks destination membership at the publication boundary", async () => {
	const f = await fixture();
	beforePublication = async () => {
		await runtime.database
			.delete(Db.organizationMembers)
			.where(eq(Db.organizationMembers.userId, f.targetId));
	};
	await expect(
		transferOrganizationContentWorkflow({ operationId: f.operationId }),
	).rejects.toThrow();
	expect((await video(f)).ownerId).toBe(f.ownerId);
	expect(state.objects.has(f.outputKey)).toBe(true);
});
it("resolves a lost publication response through the atomic progress receipt", async () => {
	const f = await fixture();
	loseResponse = true;
	await transferOrganizationContentWorkflow({ operationId: f.operationId });
	expect((await video(f)).ownerId).toBe(f.targetId);
	const [operation] = await runtime.database
		.select()
		.from(Db.agentApiOperations)
		.where(eq(Db.agentApiOperations.id, f.operationId));
	expect(operation?.state).toBe("succeeded");
	expect(operation?.result).toMatchObject({
		processedVideos: 1,
		transferredVideos: 1,
	});
});
async function loomFixture() {
	const f = await fixture();
	await runtime.database
		.update(Db.users)
		.set({ emailVerified: new Date() })
		.where(eq(Db.users.id, f.ownerId));
	const [operator] = await runtime.database
		.select()
		.from(Db.users)
		.where(eq(Db.users.id, f.ownerId));
	if (!operator) throw Error("Missing operator");
	vi.stubEnv("CAP_RUNTIME", "cloudflare");
	vi.stubEnv("CAP_OWNER_EMAIL", operator.email);
	state.user.mockReset().mockResolvedValue(operator);
	await runtime.database.insert(Db.importedVideos).values({
		id: f.videoId,
		orgId: f.orgId,
		source: "loom",
		sourceId: `loom-${f.videoId}`,
	});
	const row = await video(f);
	await runtime.database
		.update(Db.videos)
		.set({
			metadata: {
				...row.metadata,
				loomDeferredProcessing: {
					status: "pending",
					rawFileKey: f.originalKey,
				},
			},
		})
		.where(eq(Db.videos.id, f.videoId));
	return {
		...f,
		input: {
			organizationId: f.orgId,
			videoId: f.videoId,
			fromUserId: f.ownerId,
			toUserId: f.targetId,
			operatorId: f.ownerId,
		},
	};
}
it.each([true, false])(
	"reassigns an edited Loom import through the shared publication helper (keepSharing=%s)",
	async (keepSharing) => {
		const f = await loomFixture();
		const result = await reassignLoomImport({
			...f.input,
			options: { keepSharing },
		});
		expect(result).toMatchObject({
			status: "moved",
			cleanup: "failed",
			cleanupReason: expect.stringContaining("ABA safety"),
		});
		const row = await video(f);
		expect(row.ownerId).toBe(f.targetId);
		expect(row.metadata?.loomReassignClaim).toBeUndefined();
		expect(row.metadata?.loomDeferredProcessing?.rawFileKey).toBe(
			f.originalKey.replace(f.sourcePrefix, f.targetPrefix),
		);
		if (!keepSharing) expect(row.public).toBe(false);
		const shares = await runtime.database
			.select()
			.from(Db.sharedVideos)
			.where(eq(Db.sharedVideos.videoId, f.videoId));
		expect(shares).toHaveLength(keepSharing ? 1 : 0);
		const pointer = row.metadata?.transcriptPublication;
		if (!pointer) throw Error("Missing publication");
		const encrypted = state.objects.get(
			`${f.targetPrefix}.transcripts/${pointer.id}/transcription.edit.v3.json`,
		);
		if (!encrypted) throw Error("Missing encrypted words");
		expect(decryptEditTranscriptObject(encrypted, f.targetId, f.videoId)).toBe(
			f.words,
		);
		expect(state.objects.has(f.outputKey)).toBe(true);
	},
);
it("allows only one concurrent Loom ownership claim", async () => {
	const f = await loomFixture();
	const results = await Promise.all([
		reassignLoomImport(f.input),
		reassignLoomImport(f.input),
	]);
	expect(results.filter((result) => result.status === "moved")).toHaveLength(1);
	expect(results.filter((result) => result.status === "skipped")).toHaveLength(
		1,
	);
});
it("rechecks the verified migration operator at the Loom publication boundary", async () => {
	const f = await loomFixture();
	beforePublication = async () => {
		await runtime.database
			.update(Db.users)
			.set({ emailVerified: null })
			.where(eq(Db.users.id, f.ownerId));
	};
	await expect(reassignLoomImport(f.input)).rejects.toThrow("Unauthorized");
	expect(beforePublication).toBeUndefined();
	expect((await video(f)).ownerId).toBe(f.ownerId);
	expect(state.objects.has(f.outputKey)).toBe(true);
});
it("reads back an ambiguous Loom publication without republishing it", async () => {
	const f = await loomFixture();
	loseResponse = true;
	expect(await reassignLoomImport(f.input)).toMatchObject({ status: "moved" });
	const first = await video(f);
	expect(await reassignLoomImport(f.input)).toMatchObject({
		status: "skipped",
		reason: "already owned",
	});
	expect((await video(f)).metadata?.transcriptPublication?.id).toBe(
		first.metadata?.transcriptPublication?.id,
	);
});
it("safely reuses retained bytes when a later reassignment returns to the former owner", async () => {
	const f = await loomFixture();
	await transferOrganizationContentWorkflow({ operationId: f.operationId });
	expect((await video(f)).ownerId).toBe(f.targetId);
	const original = state.objects.get(f.outputKey);
	state.objects.set(
		`${f.sourcePrefix}comments/deleted-old-comment.webm`,
		"Retained unrelated version",
	);
	expect(
		await reassignLoomImport({
			...f.input,
			fromUserId: f.targetId,
			toUserId: f.ownerId,
		}),
	).toMatchObject({ status: "moved" });
	expect((await video(f)).ownerId).toBe(f.ownerId);
	expect(state.objects.get(f.outputKey)).toBe(original);
	expect(vi.mocked(fetch)).toHaveBeenCalled();
});
it("does not overwrite a conflicting retained destination object", async () => {
	const f = await loomFixture(),
		key = f.outputKey.replace(f.sourcePrefix, f.targetPrefix);
	state.objects.set(key, "Conflicting retained content");
	await expect(reassignLoomImport(f.input)).rejects.toThrow("conflicts");
	expect((await video(f)).ownerId).toBe(f.ownerId);
	expect(state.objects.get(key)).toBe("Conflicting retained content");
	expect(state.objects.has(f.outputKey)).toBe(true);
});
it("creates more than forty-eight destination folders in a single bounded mutation plan", async () => {
	const f = await fixture();
	await runtime.database
		.delete(Db.sharedVideos)
		.where(eq(Db.sharedVideos.id, f.membershipId));
	const additions = Array.from({ length: 119 }, (_, index) => ({
		id: Folder.FolderId.make(`batchf${index}`),
		organizationId: f.orgId,
		createdById: f.ownerId,
		spaceId: f.orgId,
		parentId: f.folderId,
		name: `Batch folder ${index}`,
	}));
	for (let offset = 0; offset < additions.length; offset += 10)
		await runtime.database
			.insert(Db.folders)
			.values(additions.slice(offset, offset + 10));
	const payload: ContentTransferPayload = {
		...f.payload,
		sourceFolderIds: [f.folderId, ...additions.map((folder) => folder.id)],
		folderPlan: [
			...f.payload.folderPlan,
			...additions.map((folder, index) => ({
				sourceFolderId: folder.id,
				sourceParentId: f.folderId,
				sourcePublic: false,
				destinationFolderId: `batchd${index}`,
				destinationParentId: f.destinationId,
				name: folder.name,
				color: "normal" as const,
				create: true,
			})),
		],
		videoPlan: [],
	};
	await runtime.database
		.update(Db.agentApiOperations)
		.set({ payload })
		.where(eq(Db.agentApiOperations.id, f.operationId));
	await transferOrganizationContentWorkflow({ operationId: f.operationId });
	const folders = await runtime.database
		.select()
		.from(Db.folders)
		.where(eq(Db.folders.createdById, f.targetId));
	expect(folders).toHaveLength(120);
	expect(
		folders.every((folder) => folder.spaceId === null && !folder.public),
	).toBe(true);
});
it("does not relabel a succeeded transfer when its final completion response is lost", async () => {
	const f = await fixture();
	loseCompletionResponse = true;
	await transferOrganizationContentWorkflow({ operationId: f.operationId });
	const [operation] = await runtime.database
		.select()
		.from(Db.agentApiOperations)
		.where(eq(Db.agentApiOperations.id, f.operationId));
	expect(operation?.state).toBe("succeeded");
	expect((await video(f)).ownerId).toBe(f.targetId);
	expect(loseCompletionResponse).toBe(false);
});
it("does not fail an unrelated operation kind after an invalid transfer invocation", async () => {
	const f = await fixture();
	await runtime.database
		.update(Db.agentApiOperations)
		.set({ kind: "duplicate_cap" })
		.where(eq(Db.agentApiOperations.id, f.operationId));
	await expect(
		transferOrganizationContentWorkflow({ operationId: f.operationId }),
	).rejects.toThrow();
	const [operation] = await runtime.database
		.select()
		.from(Db.agentApiOperations)
		.where(eq(Db.agentApiOperations.id, f.operationId));
	expect(operation).toMatchObject({ kind: "duplicate_cap", state: "queued" });
	expect((await video(f)).ownerId).toBe(f.ownerId);
	expect(state.access).not.toHaveBeenCalled();
});
it.each([
	"missing",
	"wrong-organization",
	"already-owned",
	"different-owner",
	"custom-storage",
	"unfinished",
	"conversion-running",
	"missing-member",
	"claimed",
] as const)("leaves unsafe Loom reassignment %s unchanged", async (reason) => {
	const f = await loomFixture();
	let input = f.input,
		expected = "";
	if (reason === "missing") {
		await runtime.database
			.delete(Db.importedVideos)
			.where(eq(Db.importedVideos.id, f.videoId));
		expected = "not a Loom import here";
	}
	if (reason === "wrong-organization") {
		const other = Organisation.OrganisationId.make("other-org");
		await runtime.database
			.insert(Db.organizations)
			.values({ id: other, ownerId: f.ownerId, name: "Other" });
		input = { ...input, organizationId: other };
		expected = "not a Loom import here";
	}
	if (reason === "already-owned") {
		await runtime.database
			.update(Db.videos)
			.set({ ownerId: f.targetId })
			.where(eq(Db.videos.id, f.videoId));
		expected = "already owned";
	}
	if (reason === "different-owner") {
		input = { ...input, fromUserId: User.UserId.make("other-user") };
		expected = "different owner";
	}
	if (reason === "custom-storage") {
		await runtime.database
			.update(Db.videos)
			.set({ bucket: S3Bucket.S3BucketId.make("custom") })
			.where(eq(Db.videos.id, f.videoId));
		expected = "custom storage";
	}
	if (reason === "unfinished") {
		await runtime.database.insert(Db.videoUploads).values({
			videoId: f.videoId,
			uploaded: 0,
			total: 0,
			mode: "singlepart",
			phase: "processing",
			rawFileKey: f.originalKey,
			startedAt: new Date(),
			updatedAt: new Date(),
		});
		expected = "import not finished";
	}
	if (reason === "conversion-running") {
		const row = await video(f);
		await runtime.database
			.update(Db.videos)
			.set({
				metadata: {
					...row.metadata,
					loomDeferredProcessing: {
						status: "started",
						rawFileKey: f.originalKey,
					},
				},
			})
			.where(eq(Db.videos.id, f.videoId));
		expected = "conversion running";
	}
	if (reason === "missing-member") {
		await runtime.database
			.delete(Db.organizationMembers)
			.where(eq(Db.organizationMembers.userId, f.targetId));
		expected = "new owner not a member";
	}
	if (reason === "claimed") {
		const row = await video(f);
		await runtime.database
			.update(Db.videos)
			.set({
				metadata: {
					...row.metadata,
					loomReassignClaim: {
						token: "existing-token",
						at: new Date().toISOString(),
					},
				},
			})
			.where(eq(Db.videos.id, f.videoId));
		expected = "another move is running";
	}
	const before = await video(f);
	expect(await reassignLoomImport(input)).toMatchObject({
		status: "skipped",
		reason: expected,
	});
	expect(await video(f)).toEqual(before);
	expect(state.access).not.toHaveBeenCalled();
	expect(state.objects.has(f.outputKey)).toBe(true);
});
it("releases only its own Loom claim after a copy verification fails", async () => {
	const f = await loomFixture();
	state.badHeadKey = f.outputKey.replace(f.sourcePrefix, f.targetPrefix);
	await expect(reassignLoomImport(f.input)).rejects.toThrow("identity changed");
	const row = await video(f);
	expect(row.ownerId).toBe(f.ownerId);
	expect(row.metadata?.loomReassignClaim).toBeUndefined();
	expect(state.objects.has(f.outputKey)).toBe(true);
});
it("preserves a replacement Loom claim and original objects after losing its claim during copying", async () => {
	const f = await loomFixture();
	state.onCopy = async () => {
		const row = await video(f);
		await runtime.database
			.update(Db.videos)
			.set({
				metadata: {
					...row.metadata,
					loomReassignClaim: {
						token: "replacement-token",
						at: new Date().toISOString(),
					},
				},
			})
			.where(eq(Db.videos.id, f.videoId));
	};
	await expect(reassignLoomImport(f.input)).rejects.toThrow(
		"changed during media copying",
	);
	const row = await video(f);
	expect(row.ownerId).toBe(f.ownerId);
	expect(row.metadata?.loomReassignClaim?.token).toBe("replacement-token");
	expect(state.objects.has(f.outputKey)).toBe(true);
	expect(
		state.objects.has(f.outputKey.replace(f.sourcePrefix, f.targetPrefix)),
	).toBe(true);
});
it("publishes an explicit absent-transcript pointer while preserving unrelated metadata", async () => {
	const f = await loomFixture();
	for (const key of [...state.objects.keys()])
		if (
			key.startsWith(f.sourcePrefix) &&
			(key.includes("/.transcripts/") ||
				key.startsWith(`${f.sourcePrefix}transcription`))
		)
			state.objects.delete(key);
	await runtime.database
		.update(Db.videos)
		.set({ metadata: { summary: "Manual summary" } })
		.where(eq(Db.videos.id, f.videoId));
	expect(await reassignLoomImport(f.input)).toMatchObject({ status: "moved" });
	const row = await video(f);
	expect(row.metadata).toMatchObject({
		summary: "Manual summary",
		transcriptPublication: { edit: false, vtt: false, revision: null },
	});
	expect(row.metadata?.loomDeferredProcessing).toBeUndefined();
});
it("accepts only a private destination folder owned by the target member", async () => {
	const f = await loomFixture(),
		folder = Folder.FolderId.make("target-folder");
	await runtime.database.insert(Db.folders).values({
		id: folder,
		organizationId: f.orgId,
		createdById: f.targetId,
		public: false,
		name: "Target",
	});
	expect(
		await reassignLoomImport({
			...f.input,
			options: { folderId: folder, keepSharing: true },
		}),
	).toMatchObject({ status: "moved" });
	expect((await video(f)).folderId).toBe(folder);
});
const internalReassign = (
	f: Awaited<ReturnType<typeof fixture>>,
	secret: string | null = "media-secret",
) =>
	reassignHttp(
		new NextRequest("https://cap.test/api/internal/loom-imports/reassign", {
			method: "POST",
			headers: {
				"Content-Type": "application/json",
				...(secret ? { "x-media-server-secret": secret } : {}),
			},
			body: JSON.stringify({
				organizationId: f.orgId,
				fromUserId: f.ownerId,
				toUserId: f.targetId,
				videoIds: [f.videoId, f.videoId],
			}),
		}),
	);
it("authenticates the internal reassignment capability before reading or copying media", async () => {
	const f = await loomFixture();
	const response = await internalReassign(f, null);
	expect(response.status).toBe(401);
	expect(state.access).not.toHaveBeenCalled();
	expect((await video(f)).ownerId).toBe(f.ownerId);
});
it("resolves the configured verified operator and reports duplicate video IDs once", async () => {
	const f = await loomFixture();
	const response = await internalReassign(f);
	expect(response.status).toBe(200);
	const body = (await response.json()) as { results: unknown[] };
	expect(body.results).toHaveLength(1);
	expect(body.results[0]).toMatchObject({
		videoId: f.videoId,
		status: "moved",
		cleanup: "failed",
		cleanupReason: expect.stringContaining("ABA safety"),
	});
	expect(state.access).toHaveBeenCalledTimes(1);
});
it("repairs a legacy pending original key to the newly verified owner's actual copy", async () => {
	const f = await loomFixture(),
		row = await video(f);
	await runtime.database
		.update(Db.videos)
		.set({
			metadata: {
				...row.metadata,
				loomDeferredProcessing: {
					status: "pending",
					rawFileKey: `legacy-owner/${f.videoId}/source/original.mp4`,
				},
			},
		})
		.where(eq(Db.videos.id, f.videoId));
	expect(await reassignLoomImport(f.input)).toMatchObject({ status: "moved" });
	expect((await video(f)).metadata?.loomDeferredProcessing?.rawFileKey).toBe(
		f.originalKey.replace(f.sourcePrefix, f.targetPrefix),
	);
	expect(
		state.objects.has(f.originalKey.replace(f.sourcePrefix, f.targetPrefix)),
	).toBe(true);
});
it("does not replace a destination object published while its multipart copy was in flight", async () => {
	const f = await loomFixture(),
		key = f.outputKey.replace(f.sourcePrefix, f.targetPrefix),
		body = state.objects.get(f.outputKey);
	if (!body) throw Error("Missing source bytes");
	const concurrent = "x".repeat(Buffer.byteLength(body));
	state.onCopy = async () => {
		state.objects.set(key, concurrent);
	};
	await expect(reassignLoomImport(f.input)).rejects.toThrow();
	expect(state.onCopy).toBeUndefined();
	expect((await video(f)).ownerId).toBe(f.ownerId);
	expect(state.objects.get(key)).toBe(concurrent);
	expect(state.objects.has(f.outputKey)).toBe(true);
});
