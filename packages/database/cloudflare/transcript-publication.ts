import { createHash, randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { z } from "zod";
import {
	decryptEditTranscriptObject,
	encryptEditTranscriptObject,
} from "../transcript-encryption.ts";
import type {
	TranscriptPublication,
	VideoMetadata,
} from "../types/metadata.ts";
import type { CloudflareDatabase } from "./index.ts";
import { videos } from "./schema.ts";

export type { TranscriptPublication } from "../types/metadata.ts";
export type TranscriptVideo = Pick<
	typeof videos.$inferSelect,
	| "id"
	| "ownerId"
	| "orgId"
	| "bucket"
	| "storageIntegrationId"
	| "source"
	| "metadata"
	| "duration"
	| "width"
	| "height"
>;
type TranscriptVideoReference = Pick<
	TranscriptVideo,
	"id" | "ownerId" | "metadata"
>;
export type TranscriptObjectStore = {
	put: (key: string, value: string, contentType: string) => Promise<unknown>;
	getText: (key: string) => Promise<string | null>;
	delete: (key: string) => Promise<unknown>;
};
export type TranscriptObjectReader = Pick<TranscriptObjectStore, "getText">;
export type PreparedTranscriptPublication = {
	videoId: TranscriptVideo["id"];
	ownerId: TranscriptVideo["ownerId"];
	expectedPointerId: string | null;
	expectedMediaRevision: string;
	pointer: TranscriptPublication;
};

const pointerSchema = z
	.object({
		version: z.literal(1),
		id: z
			.string()
			.regex(
				/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
			),
		vtt: z.boolean(),
		edit: z.boolean(),
		revision: z
			.string()
			.regex(/^[a-f0-9]{64}$/)
			.nullable(),
	})
	.strict()
	.refine((pointer) => pointer.vtt === (pointer.revision !== null));
const digest = (value: string) =>
	createHash("sha256").update(value, "utf8").digest("hex");

export class TranscriptPublicationConflictError extends Error {
	constructor() {
		super("The transcript or recording changed before publication.");
		this.name = "TranscriptPublicationConflictError";
	}
}
export class InvalidTranscriptPublicationError extends Error {
	constructor(message = "The transcript publication is invalid.") {
		super(message);
		this.name = "InvalidTranscriptPublicationError";
	}
}

function publication(
	metadata: VideoMetadata | null | undefined,
): TranscriptPublication | null {
	if (metadata === null || metadata === undefined) return null;
	if (typeof metadata !== "object" || Array.isArray(metadata))
		throw new InvalidTranscriptPublicationError();
	if (!Object.hasOwn(metadata, "transcriptPublication")) return null;
	const parsed = pointerSchema.safeParse(metadata.transcriptPublication);
	if (!parsed.success) throw new InvalidTranscriptPublicationError();
	return parsed.data;
}

function prefix(video: Pick<TranscriptVideoReference, "id" | "ownerId">) {
	if (
		![video.ownerId, video.id].every((value) =>
			/^[A-Za-z0-9_-]{1,64}$/.test(value),
		)
	)
		throw new InvalidTranscriptPublicationError(
			"Invalid transcript object identity.",
		);
	return `${video.ownerId}/${video.id}`;
}

export function getTranscriptObjectKey(
	video: TranscriptVideoReference,
	kind: "vtt" | "edit",
): string | null {
	const pointer = publication(video.metadata);
	const name =
		kind === "vtt" ? "transcription.vtt" : "transcription.edit.v3.json";
	if (!pointer) return `${prefix(video)}/${name}`;
	if (!pointer[kind]) return null;
	return `${prefix(video)}/.transcripts/${pointer.id}/${name}`;
}

function canonical(value: unknown): unknown {
	if (Array.isArray(value)) return value.map(canonical);
	if (value !== null && typeof value === "object")
		return Object.fromEntries(
			Object.entries(value)
				.sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
				.map(([key, item]) => [key, canonical(item)]),
		);
	return value;
}

export function transcriptMediaRevision(video: TranscriptVideo): string {
	return digest(
		JSON.stringify(
			canonical({
				id: video.id,
				ownerId: video.ownerId,
				orgId: video.orgId,
				bucket: video.bucket,
				storageIntegrationId: video.storageIntegrationId,
				source: video.source,
				duration: video.duration,
				width: video.width,
				height: video.height,
				edit: video.metadata?.editProcessing
					? {
							token: video.metadata.editProcessing.token,
							sourceKey: video.metadata.editProcessing.sourceKey,
							source: video.metadata.editProcessing.source,
						}
					: null,
				completedEdit: video.metadata?.completedVideoEdit ?? null,
				recording: video.metadata?.desktopRecordingUpload ?? null,
				processingToken: video.metadata?.processingRun?.token ?? null,
				transcriptionRunId: video.metadata?.transcriptionRun?.id ?? null,
			}),
		),
	);
}

export function createTranscriptInvalidation(): TranscriptPublication {
	return {
		version: 1,
		id: randomUUID(),
		vtt: false,
		edit: false,
		revision: null,
	};
}

export async function prepareTranscriptPublication(input: {
	video: TranscriptVideo;
	store: TranscriptObjectStore;
	vtt: string | null;
	editTranscript: string | null;
}): Promise<PreparedTranscriptPublication> {
	const previous = publication(input.video.metadata);
	const prepared: PreparedTranscriptPublication = {
		videoId: input.video.id,
		ownerId: input.video.ownerId,
		expectedPointerId: previous?.id ?? null,
		expectedMediaRevision: transcriptMediaRevision(input.video),
		pointer: {
			version: 1,
			id: randomUUID(),
			vtt: input.vtt !== null,
			edit: input.editTranscript !== null,
			revision: input.vtt === null ? null : digest(input.vtt),
		},
	};
	const reference = {
		id: prepared.videoId,
		ownerId: prepared.ownerId,
		metadata: { transcriptPublication: prepared.pointer },
	};
	try {
		const vttKey = getTranscriptObjectKey(reference, "vtt");
		const editKey = getTranscriptObjectKey(reference, "edit");
		if (vttKey && input.vtt !== null)
			await input.store.put(vttKey, input.vtt, "text/vtt");
		if (editKey && input.editTranscript !== null)
			await input.store.put(
				editKey,
				encryptEditTranscriptObject(
					input.editTranscript,
					prepared.ownerId,
					prepared.videoId,
				),
				"application/octet-stream",
			);
		return prepared;
	} catch (error) {
		try {
			await discardTranscriptPreparation(prepared, input.store, {
				commit: "not-attempted",
			});
		} catch (cleanupError) {
			throw new AggregateError(
				[error, cleanupError],
				"Transcript preparation and cleanup failed.",
			);
		}
		throw error;
	}
}

export function metadataWithTranscriptPublication(
	currentVideo: TranscriptVideo,
	prepared: PreparedTranscriptPublication,
	nextMetadata: VideoMetadata | null = currentVideo.metadata,
): VideoMetadata {
	const current = publication(currentVideo.metadata);
	if (
		currentVideo.id !== prepared.videoId ||
		currentVideo.ownerId !== prepared.ownerId ||
		(current?.id ?? null) !== prepared.expectedPointerId ||
		transcriptMediaRevision(currentVideo) !== prepared.expectedMediaRevision
	)
		throw new TranscriptPublicationConflictError();
	const pointer = pointerSchema.parse(prepared.pointer);
	return { ...nextMetadata, transcriptPublication: pointer };
}

export function getTranscriptPublication(video: TranscriptVideoReference) {
	return publication(video.metadata);
}

export async function readTranscriptVtt(
	video: TranscriptVideoReference,
	store: TranscriptObjectReader,
): Promise<string | null> {
	const key = getTranscriptObjectKey(video, "vtt");
	const vtt = key ? await store.getText(key) : null;
	return validateTranscriptVtt(video, vtt);
}

export function validateTranscriptVtt(
	video: TranscriptVideoReference,
	vtt: string | null,
): string | null {
	const pointer = publication(video.metadata);
	if (pointer && !pointer.vtt) return null;
	if (pointer?.vtt && vtt === null)
		throw new InvalidTranscriptPublicationError(
			"A published transcript object is missing.",
		);
	if (pointer?.vtt && vtt !== null && digest(vtt) !== pointer.revision)
		throw new InvalidTranscriptPublicationError(
			"The transcript content does not match its published revision.",
		);
	return vtt;
}

export async function readOriginalEditTranscript(
	video: TranscriptVideoReference,
	store: TranscriptObjectReader,
): Promise<string | null> {
	const pointer = publication(video.metadata);
	const key = getTranscriptObjectKey(video, "edit");
	const encrypted = key ? await store.getText(key) : null;
	if (pointer?.edit && encrypted === null)
		throw new InvalidTranscriptPublicationError(
			"A published editable transcript object is missing.",
		);
	const plaintext =
		encrypted === null
			? null
			: decryptEditTranscriptObject(encrypted, video.ownerId, video.id);
	if (encrypted !== null && plaintext === null)
		throw new InvalidTranscriptPublicationError(
			"The editable transcript cannot be authenticated.",
		);
	return plaintext;
}

export async function readTranscriptArtifacts(
	video: TranscriptVideoReference,
	store: TranscriptObjectReader,
): Promise<{ vtt: string | null; editTranscript: string | null }> {
	const [vtt, editTranscript] = await Promise.all([
		readTranscriptVtt(video, store),
		readOriginalEditTranscript(video, store),
	]);
	return { vtt, editTranscript };
}

export async function readTranscriptPublicationOutcome(
	database: CloudflareDatabase,
	prepared: PreparedTranscriptPublication,
): Promise<{
	state: "published" | "not-current" | "video-missing";
	publicationId: string | null;
}> {
	const [video] = await database
		.select({ ownerId: videos.ownerId, metadata: videos.metadata })
		.from(videos)
		.where(eq(videos.id, prepared.videoId))
		.limit(1);
	if (!video) return { state: "video-missing", publicationId: null };
	const current = publication(video.metadata);
	return {
		state:
			video.ownerId === prepared.ownerId && current?.id === prepared.pointer.id
				? "published"
				: "not-current",
		publicationId: current?.id ?? null,
	};
}

export async function discardTranscriptPreparation(
	prepared: PreparedTranscriptPublication,
	store: TranscriptObjectStore,
	proof: { commit: "not-attempted" | "rolled-back" },
): Promise<void> {
	if (proof.commit !== "not-attempted" && proof.commit !== "rolled-back")
		throw new Error(
			"Ambiguous transcript commits must be retained for reconciliation.",
		);
	const reference = {
		id: prepared.videoId,
		ownerId: prepared.ownerId,
		metadata: { transcriptPublication: prepared.pointer },
	};
	const keys = [
		getTranscriptObjectKey(reference, "vtt"),
		getTranscriptObjectKey(reference, "edit"),
	].filter((key): key is string => key !== null);
	await Promise.all(keys.map((key) => store.delete(key)));
}
