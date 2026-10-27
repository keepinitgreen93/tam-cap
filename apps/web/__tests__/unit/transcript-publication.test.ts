import { atomic } from "@cap/database/cloudflare/atomic";
import { videos } from "@cap/database/cloudflare/schema";
import {
	createTranscriptInvalidation,
	discardTranscriptPreparation,
	getTranscriptObjectKey,
	metadataWithTranscriptPublication,
	prepareTranscriptPublication,
	readTranscriptArtifacts,
	readTranscriptPublicationOutcome,
	type TranscriptObjectStore,
	TranscriptPublicationConflictError,
} from "@cap/database/cloudflare/transcript-publication";
import { nanoId } from "@cap/database/helpers";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { createTestDatabase } from "../../../../packages/database/cloudflare/test-runtime.ts";
import { createTestOwner } from "../helpers/cloudflare-team";

vi.mock("@cap/env", () => ({
	serverEnv: () => ({
		NEXTAUTH_SECRET: "synthetic-transcript-encryption-secret",
	}),
}));
let fixture: Awaited<ReturnType<typeof createTestDatabase>>;
const memoryStore = () => {
	const objects = new Map<string, string>();
	const store: TranscriptObjectStore = {
		put: async (key, value) => {
			objects.set(key, value);
		},
		getText: async (key) => objects.get(key) ?? null,
		delete: async (key) => {
			objects.delete(key);
		},
	};
	return { objects, store };
};
async function videoFixture() {
	const owner = await createTestOwner(fixture.database);
	const [video] = await fixture.database
		.insert(videos)
		.values({
			id: nanoId() as typeof videos.$inferInsert.id,
			ownerId: owner.id,
			orgId: owner.activeOrganizationId,
			name: "Transcript",
			source: { type: "webMP4" },
			duration: 10,
		})
		.returning();
	if (!video) throw new Error("Video fixture missing");
	return video;
}

describe("immutable transcript publication", () => {
	beforeAll(async () => {
		fixture = await createTestDatabase();
	});
	afterAll(async () => fixture?.dispose());
	it("uses legacy keys only without a pointer and rejects malformed pointers", async () => {
		const video = await videoFixture();
		expect(getTranscriptObjectKey(video, "vtt")).toBe(
			`${video.ownerId}/${video.id}/transcription.vtt`,
		);
		expect(() =>
			getTranscriptObjectKey(
				{
					...video,
					metadata: {
						transcriptPublication: {
							version: 1,
							id: "../escape",
							vtt: true,
							edit: false,
							revision: "a".repeat(64),
						},
					},
				},
				"vtt",
			),
		).toThrow();
		expect(
			getTranscriptObjectKey(
				{
					...video,
					metadata: { transcriptPublication: createTranscriptInvalidation() },
				},
				"vtt",
			),
		).toBeNull();
	});
	it("stages a paired VTT and authenticated encrypted original-word object before publishing", async () => {
		const video = await videoFixture();
		const { store, objects } = memoryStore();
		const prepared = await prepareTranscriptPublication({
			video,
			store,
			vtt: "WEBVTT\nfirst\n",
			editTranscript: '{"original":"words"}',
		});
		expect(prepared.pointer.id).toMatch(/^[0-9a-f-]{36}$/);
		expect(
			[...objects.keys()].every((key) =>
				key.startsWith(`${video.ownerId}/${video.id}/.transcripts/`),
			),
		).toBe(true);
		expect(
			[...objects.values()].some((value) => value.includes('"original"')),
		).toBe(false);
		const metadata = metadataWithTranscriptPublication(video, prepared, {
			summary: "preserved",
		});
		expect(metadata.summary).toBe("preserved");
		expect(
			await readTranscriptArtifacts({ ...video, metadata }, store),
		).toEqual({
			vtt: "WEBVTT\nfirst\n",
			editTranscript: '{"original":"words"}',
		});
	});
	it("only one competing preparation can publish against the same prior version", async () => {
		const video = await videoFixture();
		const { store } = memoryStore();
		const candidates = await Promise.all(
			["one", "two"].map((text) =>
				prepareTranscriptPublication({
					video,
					store,
					vtt: `WEBVTT\n${text}\n`,
					editTranscript: JSON.stringify({ text }),
				}),
			),
		);
		const outcomes = await Promise.allSettled(
			candidates.map((prepared) =>
				atomic(fixture.database, async (snapshot) => {
					const [current] = await snapshot.read((reader) =>
						reader.select().from(videos).where(eq(videos.id, video.id)),
					);
					if (!current) throw new Error("Missing video");
					return {
						statements: [
							fixture.database
								.update(videos)
								.set({
									metadata: metadataWithTranscriptPublication(
										current,
										prepared,
									),
								})
								.where(eq(videos.id, video.id)),
						],
						result: prepared.pointer.id,
					};
				}),
			),
		);
		expect(
			outcomes.filter((result) => result.status === "fulfilled"),
		).toHaveLength(1);
		const failure = outcomes.find((result) => result.status === "rejected");
		expect(
			failure?.status === "rejected" &&
				failure.reason instanceof TranscriptPublicationConflictError,
		).toBe(true);
		const [current] = await fixture.database
			.select()
			.from(videos)
			.where(eq(videos.id, video.id));
		if (!current) throw new Error("Missing video");
		const artifacts = await readTranscriptArtifacts(current, store);
		const word = artifacts.vtt?.includes("one") ? "one" : "two";
		expect(artifacts.editTranscript).toBe(JSON.stringify({ text: word }));
	});
	it("refuses media changes and keeps committed objects after readback", async () => {
		const video = await videoFixture();
		const { store, objects } = memoryStore();
		const prepared = await prepareTranscriptPublication({
			video,
			store,
			vtt: "WEBVTT\n",
			editTranscript: null,
		});
		expect(() =>
			metadataWithTranscriptPublication({ ...video, duration: 11 }, prepared),
		).toThrow(TranscriptPublicationConflictError);
		await fixture.database
			.update(videos)
			.set({ metadata: metadataWithTranscriptPublication(video, prepared) })
			.where(eq(videos.id, video.id));
		expect(
			await readTranscriptPublicationOutcome(fixture.database, prepared),
		).toMatchObject({ state: "published", publicationId: prepared.pointer.id });
		expect(objects.size).toBe(1);
	});
	it("re-encrypts a duplicate for its own identity and cleans known uncommitted preparations", async () => {
		const video = await videoFixture();
		const { store, objects } = memoryStore();
		const prepared = await prepareTranscriptPublication({
			video,
			store,
			vtt: "WEBVTT\n",
			editTranscript: '{"original":"words"}',
		});
		const published = {
			...video,
			metadata: metadataWithTranscriptPublication(video, prepared),
		};
		const target = {
			...video,
			id: nanoId() as typeof video.id,
			metadata: null,
		};
		const artifacts = await readTranscriptArtifacts(published, store);
		const duplicate = await prepareTranscriptPublication({
			video: target,
			store,
			...artifacts,
		});
		expect(
			await readTranscriptArtifacts(
				{
					...target,
					metadata: metadataWithTranscriptPublication(target, duplicate),
				},
				store,
			),
		).toEqual(artifacts);
		await discardTranscriptPreparation(duplicate, store, {
			commit: "not-attempted",
		});
		expect(objects.size).toBe(2);
	});
});
