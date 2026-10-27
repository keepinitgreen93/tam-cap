import "server-only";

import { createHash } from "node:crypto";
import {
	type AtomicPlan,
	type AtomicSnapshot,
	type AtomicStatement,
	atomic,
} from "@cap/database/cloudflare/atomic";
import * as Db from "@cap/database/cloudflare/schema";
import { nanoId } from "@cap/database/helpers";
import { CloudflareDatabase, type CloudflareDbClient } from "@cap/web-backend";
import {
	Agent,
	Comment,
	type DatabaseError,
	type Video,
} from "@cap/web-domain";
import { and, eq } from "drizzle-orm";
import { Effect, Option, Schedule, Schema } from "effect";
import { revalidatePath } from "next/cache";
import { createNotification } from "@/lib/Notification";
import { enqueueVideoStorageNameSync } from "@/lib/sync-video-storage-names";

export type AgentMutationOutcome<A> =
	| { state: "success"; response: A }
	| { state: "not_found" }
	| { state: "forbidden" }
	| { state: "conflict" };

type IdempotencyInput = {
	userId: Agent.AgentPrincipal["Type"]["id"];
	operation: string;
	key: string;
	requestHash: string;
	expiresAt: Date;
};

const hash = (value: string) =>
	createHash("sha256").update(value).digest("hex");

export const agentMutationRequestHash = (operation: string, request: unknown) =>
	hash(JSON.stringify({ operation, request }));

export const isAgentIdempotencyKey = (value: string | undefined) =>
	typeof value === "string" &&
	value.length >= 8 &&
	value.length <= 128 &&
	/^[A-Za-z0-9._-]+$/.test(value);

const acquireIdempotency = async (
	snapshot: AtomicSnapshot,
	database: CloudflareDbClient,
	input: IdempotencyInput,
	candidateId: string,
	now: Date,
) => {
	const keyHash = hash(input.key);
	const [record] = await snapshot.read((reader) =>
		reader
			.select()
			.from(Db.agentApiIdempotency)
			.where(
				and(
					eq(Db.agentApiIdempotency.userId, input.userId),
					eq(Db.agentApiIdempotency.operation, input.operation),
					eq(Db.agentApiIdempotency.keyHash, keyHash),
				),
			)
			.limit(1),
	);
	if (record && record.expiresAt.getTime() > now.getTime()) {
		if (record.requestHash !== input.requestHash)
			return { state: "conflict" as const };
		if (record.state === "complete")
			return { state: "replay" as const, record };
		return { state: "pending" as const };
	}
	const projected: typeof Db.agentApiIdempotency.$inferSelect = {
		id: record?.id ?? candidateId,
		userId: input.userId,
		operation: input.operation,
		keyHash,
		requestHash: input.requestHash,
		expiresAt: input.expiresAt,
		state: "pending",
		response: null,
		statusCode: null,
		createdAt: record?.createdAt ?? now,
		updatedAt: now,
	};
	const statement = record
		? database
				.update(Db.agentApiIdempotency)
				.set(projected)
				.where(eq(Db.agentApiIdempotency.id, record.id))
		: database.insert(Db.agentApiIdempotency).values(projected);
	return { state: "new" as const, record: projected, statements: [statement] };
};

const completeIdempotency = (
	database: CloudflareDbClient,
	id: string,
	response: unknown,
) =>
	database
		.update(Db.agentApiIdempotency)
		.set({ state: "complete", statusCode: 200, response })
		.where(
			and(
				eq(Db.agentApiIdempotency.id, id),
				eq(Db.agentApiIdempotency.state, "pending"),
			),
		);
const releaseIdempotency = (database: CloudflareDbClient, id: string) =>
	database
		.delete(Db.agentApiIdempotency)
		.where(
			and(
				eq(Db.agentApiIdempotency.id, id),
				eq(Db.agentApiIdempotency.state, "pending"),
			),
		);

const commonError = (requestId: string, message: string) => ({
	message,
	retryable: false,
	retryAfterMs: null,
	requestId,
});

const badRequest = (requestId: string, message: string) =>
	new Agent.AgentBadRequestError({
		...commonError(requestId, message),
		code: "INVALID_REQUEST",
	});

const notFound = (requestId: string) =>
	new Agent.AgentNotFoundError({
		...commonError(requestId, "The requested resource was not found"),
		code: "NOT_FOUND",
	});

const temporarilyUnavailable = (requestId: string) =>
	new Agent.AgentTemporaryUnavailableError({
		message: "The mutation could not be completed",
		code: "TEMPORARY_UNAVAILABLE",
		retryable: true,
		retryAfterMs: 500,
		requestId,
	});

const idempotencyConflict = (requestId: string) =>
	new Agent.AgentConflictError({
		...commonError(
			requestId,
			"Idempotency key was already used for a different request",
		),
		code: "IDEMPOTENCY_CONFLICT",
	});

export const readAgentMutationReplay = <A>(input: {
	principal: Agent.AgentPrincipal["Type"];
	operation: string;
	idempotencyKey: string;
	request: unknown;
	requestId: string;
	decodeReplay: (value: unknown) => A;
}) =>
	Effect.gen(function* () {
		if (!isAgentIdempotencyKey(input.idempotencyKey))
			return yield* badRequest(
				input.requestId,
				"A valid Idempotency-Key header is required",
			);
		const database = yield* CloudflareDatabase;
		const [record] = yield* database.use((db) =>
			db
				.select()
				.from(Db.agentApiIdempotency)
				.where(
					and(
						eq(Db.agentApiIdempotency.userId, input.principal.id),
						eq(Db.agentApiIdempotency.operation, input.operation),
						eq(Db.agentApiIdempotency.keyHash, hash(input.idempotencyKey)),
					),
				)
				.limit(1),
		);
		if (!record || record.expiresAt.getTime() <= Date.now())
			return Option.none<A>();
		if (
			record.requestHash !==
			agentMutationRequestHash(input.operation, input.request)
		)
			return yield* idempotencyConflict(input.requestId);
		if (record.state !== "complete")
			return yield* temporarilyUnavailable(input.requestId);
		return Option.some(input.decodeReplay(record.response));
	});

export const runAgentMutation = <A>(input: {
	principal: Agent.AgentPrincipal["Type"];
	operation: string;
	idempotencyKey: string;
	request: unknown;
	requestId: string;
	decodeReplay: (value: unknown) => A;
	execute: (
		snapshot: AtomicSnapshot,
		database: CloudflareDbClient,
	) => Promise<AtomicPlan<AgentMutationOutcome<NoInfer<A>>>>;
}): Effect.Effect<
	A,
	| Agent.AgentBadRequestError
	| Agent.AgentConflictError
	| Agent.AgentTemporaryUnavailableError
	| Agent.AgentNotFoundError
	| Agent.AgentForbiddenError
	| DatabaseError,
	CloudflareDatabase
> =>
	Effect.gen(function* () {
		if (!isAgentIdempotencyKey(input.idempotencyKey)) {
			return yield* badRequest(
				input.requestId,
				"A valid Idempotency-Key header is required",
			);
		}
		const database = yield* CloudflareDatabase;
		const now = new Date();
		const candidateId = nanoId();
		const requestHash = agentMutationRequestHash(
			input.operation,
			input.request,
		);
		const result = yield* database.use((db) =>
			atomic<
				| AgentMutationOutcome<A>
				| { state: "idempotency_conflict" | "pending" }
				| { state: "replay"; response: A }
			>(db, async (snapshot) => {
				const statements: AtomicStatement[] = [];
				const idempotency = await acquireIdempotency(
					snapshot,
					db,
					{
						userId: input.principal.id,
						operation: input.operation,
						key: input.idempotencyKey,
						requestHash,
						expiresAt: new Date(now.getTime() + 24 * 60 * 60 * 1000),
					},
					candidateId,
					now,
				);
				if (idempotency.state === "new")
					statements.push(...idempotency.statements);
				if (idempotency.state === "conflict") {
					return {
						statements,
						result: { state: "idempotency_conflict" as const },
					};
				}

				if (idempotency.state === "pending") {
					return { statements, result: { state: "pending" as const } };
				}
				if (idempotency.state === "replay") {
					return {
						statements,
						result: {
							state: "replay" as const,
							response: input.decodeReplay(idempotency.record.response),
						},
					};
				}
				const planned = await input.execute(snapshot, db);
				const outcome = planned.result;
				if (outcome.state === "success") statements.push(...planned.statements);
				if (outcome.state !== "success") {
					statements.push(releaseIdempotency(db, idempotency.record.id));
					return { statements, result: outcome };
				}
				statements.push(
					completeIdempotency(db, idempotency.record.id, outcome.response),
				);
				return { statements, result: outcome };
			}),
		);
		if (result.state === "idempotency_conflict") {
			return yield* idempotencyConflict(input.requestId);
		}
		if (result.state === "pending") {
			return yield* temporarilyUnavailable(input.requestId);
		}
		if (result.state === "not_found") return yield* notFound(input.requestId);
		if (result.state === "forbidden") {
			return yield* new Agent.AgentForbiddenError({
				...commonError(input.requestId, "Access is not allowed"),
				code: "FORBIDDEN",
			});
		}
		if (result.state === "conflict") {
			return yield* new Agent.AgentConflictError({
				...commonError(
					input.requestId,
					"The resource changed; refresh and retry",
				),
				code: "CONFLICT",
			});
		}
		if (result.state === "success" || result.state === "replay") {
			return result.response;
		}
		return yield* temporarilyUnavailable(input.requestId);
	});

export const runAgentExternalMutation = <A, E, R>(input: {
	principal: Agent.AgentPrincipal["Type"];
	operation: string;
	idempotencyKey: string;
	request: unknown;
	requestId: string;
	decodeReplay: (value: unknown) => A;
	execute: (providerIdempotencyKey: string) => Effect.Effect<A, E, R>;
}): Effect.Effect<
	A,
	| E
	| Agent.AgentBadRequestError
	| Agent.AgentConflictError
	| Agent.AgentTemporaryUnavailableError
	| DatabaseError,
	R | CloudflareDatabase
> =>
	Effect.gen(function* () {
		if (!isAgentIdempotencyKey(input.idempotencyKey)) {
			return yield* badRequest(
				input.requestId,
				"A valid Idempotency-Key header is required",
			);
		}
		const database = yield* CloudflareDatabase;
		const now = new Date();
		const candidateId = nanoId();
		const requestHash = agentMutationRequestHash(
			input.operation,
			input.request,
		);
		const acquired = yield* database.use((db) =>
			atomic<
				| Exclude<
						Awaited<ReturnType<typeof acquireIdempotency>>,
						{ state: "replay" }
				  >
				| { state: "replay"; response: A }
			>(db, async (snapshot) => {
				const statements: AtomicStatement[] = [];
				const idempotency = await acquireIdempotency(
					snapshot,
					db,
					{
						userId: input.principal.id,
						operation: input.operation,
						key: input.idempotencyKey,
						requestHash,
						expiresAt: new Date(now.getTime() + 24 * 60 * 60 * 1000),
					},
					candidateId,
					now,
				);
				if (idempotency.state === "new")
					statements.push(...idempotency.statements);
				if (idempotency.state === "replay") {
					return {
						statements,
						result: {
							state: "replay" as const,
							response: input.decodeReplay(idempotency.record.response),
						},
					};
				}
				return { statements, result: idempotency };
			}),
		);
		if (acquired.state === "conflict") {
			return yield* idempotencyConflict(input.requestId);
		}
		if (acquired.state === "pending") {
			return yield* temporarilyUnavailable(input.requestId);
		}
		if (acquired.state === "replay") return acquired.response;
		const providerIdempotencyKey = hash(
			`${input.principal.id}\0${input.operation}\0${input.idempotencyKey}`,
		);
		const response = yield* input
			.execute(providerIdempotencyKey)
			.pipe(
				Effect.tapErrorCause(() =>
					database.use((db) =>
						db
							.delete(Db.agentApiIdempotency)
							.where(
								and(
									eq(Db.agentApiIdempotency.id, acquired.record.id),
									eq(Db.agentApiIdempotency.state, "pending"),
									eq(Db.agentApiIdempotency.requestHash, requestHash),
									eq(
										Db.agentApiIdempotency.expiresAt,
										acquired.record.expiresAt,
									),
								),
							),
					),
				),
			);
		return yield* database
			.use((db) =>
				atomic<A>(db, async (snapshot) => {
					const statements: AtomicStatement[] = [];
					const [record] = await snapshot.read((reader) =>
						reader
							.select()
							.from(Db.agentApiIdempotency)
							.where(eq(Db.agentApiIdempotency.id, acquired.record.id))
							.limit(1),
					);
					if (
						!record ||
						record.requestHash !== requestHash ||
						record.expiresAt.getTime() !== acquired.record.expiresAt.getTime()
					) {
						throw new Error("Could not complete external agent mutation");
					}
					if (record.state === "complete") {
						return { statements, result: input.decodeReplay(record.response) };
					}
					statements.push(completeIdempotency(db, record.id, response));
					return { statements, result: response };
				}),
			)
			.pipe(
				Effect.retry({
					times: 3,
					schedule: Schedule.exponential("25 millis"),
				}),
			);
	});

export const createAgentFeedback = Effect.fn("Agent.createFeedback")(
	function* (input: {
		videoId: Video.VideoId;
		principal: Agent.AgentPrincipal["Type"];
		type: "text" | "emoji";
		content: string;
		timestampMs: number | null;
		parentCommentId: Comment.CommentId | null;
		idempotencyKey: string;
		requestId: string;
		durationMs: number | null;
	}) {
		const content = input.content.trim();
		const maximumLength = input.type === "emoji" ? 64 : 10_000;
		if (content.length === 0 || content.length > maximumLength) {
			return yield* badRequest(input.requestId, "Feedback content is invalid");
		}
		if (
			input.timestampMs !== null &&
			(!Number.isFinite(input.timestampMs) ||
				input.timestampMs < 0 ||
				(input.durationMs !== null &&
					input.timestampMs > input.durationMs + 1_000))
		) {
			return yield* badRequest(input.requestId, "timestampMs is invalid");
		}
		if (!isAgentIdempotencyKey(input.idempotencyKey)) {
			return yield* badRequest(
				input.requestId,
				"A valid Idempotency-Key header is required",
			);
		}

		const database = yield* CloudflareDatabase;
		const now = new Date();
		const candidateId = nanoId();
		const operation = input.parentCommentId
			? "create_reply"
			: input.type === "emoji"
				? "create_reaction"
				: "create_comment";
		const requestHash = hash(
			JSON.stringify({
				videoId: input.videoId,
				type: input.type,
				content,
				timestampMs: input.timestampMs,
				parentCommentId: input.parentCommentId,
			}),
		);
		const result = yield* database.use((db) =>
			atomic<
				| { state: "conflict" }
				| { state: "pending" }
				| { state: "not_found" }
				| {
						state: "replay" | "created";
						response: typeof Agent.AgentFeedbackResponse.Type;
				  }
			>(db, async (snapshot) => {
				const statements: AtomicStatement[] = [];
				const idempotency = await acquireIdempotency(
					snapshot,
					db,
					{
						userId: input.principal.id,
						operation,
						key: input.idempotencyKey,
						requestHash,
						expiresAt: new Date(now.getTime() + 24 * 60 * 60 * 1000),
					},
					candidateId,
					now,
				);
				if (idempotency.state === "new")
					statements.push(...idempotency.statements);
				if (idempotency.state === "conflict") {
					return { statements, result: { state: "conflict" as const } };
				}

				if (idempotency.state === "pending") {
					return { statements, result: { state: "pending" as const } };
				}
				if (idempotency.state === "replay") {
					return {
						statements,
						result: {
							state: "replay" as const,
							response: Schema.decodeUnknownSync(Agent.AgentFeedbackResponse)(
								idempotency.record.response,
							),
						},
					};
				}
				const parentCommentId = input.parentCommentId;
				if (parentCommentId) {
					const [parent] = await snapshot.read((reader) =>
						reader
							.select({ id: Db.comments.id })
							.from(Db.comments)
							.where(
								and(
									eq(Db.comments.id, parentCommentId),
									eq(Db.comments.videoId, input.videoId),
									eq(Db.comments.type, "text"),
								),
							)
							.limit(1),
					);
					if (!parent) {
						statements.push(releaseIdempotency(db, idempotency.record.id));
						return { statements, result: { state: "not_found" as const } };
					}
				}
				const id = Comment.CommentId.make(candidateId);
				statements.push(
					db.insert(Db.comments).values({
						id,
						authorId: input.principal.id,
						type: input.type,
						content,
						videoId: input.videoId,
						timestamp:
							input.timestampMs === null ? null : input.timestampMs / 1_000,
						parentCommentId: input.parentCommentId,
						createdAt: now,
						updatedAt: now,
					}),
				);
				const response = {
					id,
					videoId: input.videoId,
					type: input.type,
					content,
					timestampMs: input.timestampMs,
					parentCommentId: input.parentCommentId,
					createdAt: now.toISOString(),
					updatedAt: now.toISOString(),
					author: { id: input.principal.id, name: null },
					requestId: input.requestId,
				};
				statements.push(
					completeIdempotency(db, idempotency.record.id, response),
				);
				return { statements, result: { state: "created" as const, response } };
			}),
		);

		if (result.state === "conflict") {
			return yield* idempotencyConflict(input.requestId);
		}
		if (result.state === "pending") {
			return yield* temporarilyUnavailable(input.requestId);
		}
		if (result.state === "not_found") {
			return yield* notFound(input.requestId);
		}
		if (result.state === "created") {
			const notificationType = input.parentCommentId
				? "reply"
				: input.type === "emoji"
					? "reaction"
					: "comment";
			yield* Effect.tryPromise(() =>
				createNotification({
					type: notificationType,
					videoId: input.videoId,
					authorId: input.principal.id,
					comment: {
						id: result.response.id,
						content: result.response.content,
					},
					parentCommentId: input.parentCommentId ?? undefined,
				}),
			).pipe(Effect.catchAll(() => Effect.void));
		}
		yield* Effect.try(() => revalidatePath(`/s/${input.videoId}`)).pipe(
			Effect.catchAll(() => Effect.void),
		);
		return result.response;
	},
);

export const updateAgentCap = Effect.fn("Agent.updateCap")(function* (input: {
	videoId: Video.VideoId;
	principal: Agent.AgentPrincipal["Type"];
	title: string | undefined;
	public: boolean | undefined;
	idempotencyKey: string;
	requestId: string;
}) {
	const title = input.title?.trim();
	if (
		(title === undefined && input.public === undefined) ||
		(title !== undefined && (title.length === 0 || title.length > 200)) ||
		!isAgentIdempotencyKey(input.idempotencyKey)
	) {
		return yield* badRequest(input.requestId, "The Cap update is invalid");
	}
	const requestHash = hash(
		JSON.stringify({ videoId: input.videoId, title, public: input.public }),
	);
	const database = yield* CloudflareDatabase;
	const now = new Date();
	const candidateId = nanoId();
	const result = yield* database.use((db) =>
		atomic<
			| { state: "conflict" }
			| { state: "pending" }
			| { state: "not_found" }
			| {
					state: "replay" | "updated";
					response: typeof Agent.AgentCapUpdateResponse.Type;
			  }
		>(db, async (snapshot) => {
			const statements: AtomicStatement[] = [];
			const idempotency = await acquireIdempotency(
				snapshot,
				db,
				{
					userId: input.principal.id,
					operation: "update_cap",
					key: input.idempotencyKey,
					requestHash,
					expiresAt: new Date(now.getTime() + 24 * 60 * 60 * 1000),
				},
				candidateId,
				now,
			);
			if (idempotency.state === "new")
				statements.push(...idempotency.statements);
			if (idempotency.state === "conflict") {
				return { statements, result: { state: "conflict" as const } };
			}

			if (idempotency.state === "pending") {
				return { statements, result: { state: "pending" as const } };
			}
			if (idempotency.state === "replay") {
				return {
					statements,
					result: {
						state: "replay" as const,
						response: Schema.decodeUnknownSync(Agent.AgentCapUpdateResponse)(
							idempotency.record.response,
						),
					},
				};
			}
			const [video] = await snapshot.read((reader) =>
				reader
					.select({
						name: Db.videos.name,
						public: Db.videos.public,
						metadata: Db.videos.metadata,
					})
					.from(Db.videos)
					.where(
						and(
							eq(Db.videos.id, input.videoId),
							eq(Db.videos.ownerId, input.principal.id),
						),
					)
					.limit(1),
			);
			if (!video) {
				statements.push(releaseIdempotency(db, idempotency.record.id));
				return { statements, result: { state: "not_found" as const } };
			}
			const metadata =
				video.metadata &&
				typeof video.metadata === "object" &&
				!Array.isArray(video.metadata)
					? video.metadata
					: {};
			statements.push(
				db
					.update(Db.videos)
					.set({
						name: title ?? video.name,
						public: input.public ?? video.public,
						updatedAt: now,
						metadata:
							title === undefined
								? metadata
								: { ...metadata, titleManuallyEdited: true },
					})
					.where(eq(Db.videos.id, input.videoId)),
			);
			const response = {
				id: input.videoId,
				title: title ?? video.name,
				public: input.public ?? video.public,
				updatedAt: now.toISOString(),
				requestId: input.requestId,
			};
			statements.push(completeIdempotency(db, idempotency.record.id, response));
			return { statements, result: { state: "updated" as const, response } };
		}),
	);
	if (result.state === "conflict") {
		return yield* idempotencyConflict(input.requestId);
	}
	if (result.state === "pending") {
		return yield* temporarilyUnavailable(input.requestId);
	}
	if (result.state === "not_found") return yield* notFound(input.requestId);
	if (title !== undefined) {
		yield* Effect.promise(() => enqueueVideoStorageNameSync(input.videoId));
	}
	yield* Effect.try(() => {
		revalidatePath("/dashboard/caps");
		revalidatePath("/dashboard/shared-caps");
		revalidatePath(`/s/${input.videoId}`);
	}).pipe(Effect.catchAll(() => Effect.void));
	return result.response;
});
