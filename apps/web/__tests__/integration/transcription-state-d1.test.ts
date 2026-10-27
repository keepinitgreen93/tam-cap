import { videos } from "@cap/database/cloudflare/schema";
import {
	claimTranscriptionRun,
	releaseTranscriptionRun,
	setTranscriptionRunStatus,
	transcriptionAudioFilename,
	validateTranscriptionRun,
} from "@cap/database/cloudflare/transcription-state";
import { nanoId } from "@cap/database/helpers";
import { eq } from "drizzle-orm";
import {
	afterAll,
	beforeAll,
	beforeEach,
	describe,
	expect,
	it,
	vi,
} from "vitest";
import { createTestDatabase } from "../../../../packages/database/cloudflare/test-runtime.ts";
import { createTestOwner } from "../helpers/cloudflare-team";

vi.mock("server-only", () => ({}));
const state = vi.hoisted(() => ({
	database: undefined as
		| Awaited<ReturnType<typeof createTestDatabase>>["database"]
		| undefined,
	dispatch: vi.fn(),
	transcribe: vi.fn(),
}));
vi.mock("@cap/database/cloudflare/application", () => ({
	db: () => {
		if (!state.database) throw new Error("Test database missing");
		return state.database;
	},
}));
vi.mock("@cap/env", () => ({
	serverEnv: () => ({
		TRANSCRIPTION_PROVIDER: "cloudflare",
		CLOUDFLARE_ACCOUNT_ID: "a".repeat(32),
		CLOUDFLARE_AI_API_TOKEN: "synthetic",
		NEXTAUTH_SECRET: "synthetic-key",
	}),
	buildEnv: { NEXT_PUBLIC_IS_CAP: "false" },
}));
vi.mock("@/lib/transcription-dispatch", () => ({
	dispatchTranscriptionRun: state.dispatch,
}));
vi.mock("@/lib/transcription-provider", () => ({
	transcribeAudio: state.transcribe,
}));
vi.mock("@/lib/generate-ai", () => ({ startAiGeneration: vi.fn() }));

import { transcribeVideoWorkflow } from "@/workflows/transcribe";

let fixture: Awaited<ReturnType<typeof createTestDatabase>>;
let video: typeof videos.$inferSelect;

describe("transcription run ownership on D1", () => {
	beforeAll(async () => {
		fixture = await createTestDatabase();
		state.database = fixture.database;
	});
	afterAll(async () => fixture?.dispose());
	beforeEach(async () => {
		state.dispatch.mockReset().mockResolvedValue(undefined);
		state.transcribe.mockReset();
		const owner = await createTestOwner(fixture.database);
		const [row] = await fixture.database
			.insert(videos)
			.values({
				id: nanoId() as typeof videos.$inferInsert.id,
				ownerId: owner.id,
				orgId: owner.activeOrganizationId,
				name: "Recording",
				source: { type: "desktopSegments" },
				duration: 10,
			})
			.returning();
		if (!row) throw new Error("Fixture video missing");
		video = row;
	});
	it("allows only one concurrent dispatcher and keeps validation retries on the same run", async () => {
		const claims = await Promise.all(
			Array.from({ length: 5 }, () =>
				claimTranscriptionRun(fixture.database, video.id, video.ownerId),
			),
		);
		expect(claims.filter(Boolean)).toHaveLength(1);
		const claim = claims.find(Boolean);
		if (!claim) throw new Error("Claim missing");
		const id = claim.video.metadata.transcriptionRun.id;
		for (let attempt = 0; attempt < 2; attempt++)
			expect(
				await validateTranscriptionRun(
					fixture.database,
					video.id,
					video.ownerId,
					id,
				),
			).toMatchObject({
				state: "ready",
				video: { metadata: { transcriptionRun: { id } } },
			});
	});
	it("releases a changed-source old run without resetting a newer run or its temp object", async () => {
		const first = await claimTranscriptionRun(
			fixture.database,
			video.id,
			video.ownerId,
		);
		if (!first) throw new Error("Claim missing");
		const oldKey = transcriptionAudioFilename(first.video);
		await fixture.database
			.update(videos)
			.set({
				source: {
					type: "desktopMP4",
					outputKey: `${video.ownerId}/${video.id}/muxed.mp4`,
				},
				duration: 10.1,
				metadata: {
					...first.video.metadata,
					desktopRecordingUpload: {
						version: 1,
						artifact: { kind: "segments", manifestSha256: "a".repeat(64) },
						fileSize: 100,
						duration: 10.1,
						hasAudio: true,
						fullDecode: true,
						objectIdentity: "muxed",
					},
				},
			})
			.where(eq(videos.id, video.id));
		expect(
			await validateTranscriptionRun(
				fixture.database,
				video.id,
				video.ownerId,
				first.video.metadata.transcriptionRun.id,
			),
		).toEqual({ state: "source-changed" });
		expect(
			await releaseTranscriptionRun(fixture.database, {
				videoId: video.id,
				ownerId: video.ownerId,
				runId: first.video.metadata.transcriptionRun.id,
			}),
		).toBe(true);
		const second = await claimTranscriptionRun(
			fixture.database,
			video.id,
			video.ownerId,
		);
		if (!second) throw new Error("Second claim missing");
		const newKey = transcriptionAudioFilename(second.video);
		expect(newKey).not.toBe(oldKey);
		const tempObjects = new Map([
			[oldKey, "old source"],
			[newKey, "new source"],
		]);
		tempObjects.delete(oldKey);
		expect(tempObjects.get(newKey)).toBe("new source");
		expect(
			await setTranscriptionRunStatus(fixture.database, first.video, "ERROR"),
		).toBe(false);
		expect(
			await releaseTranscriptionRun(fixture.database, {
				videoId: video.id,
				ownerId: video.ownerId,
				runId: first.video.metadata.transcriptionRun.id,
			}),
		).toBe(false);
		expect(
			await validateTranscriptionRun(
				fixture.database,
				video.id,
				video.ownerId,
				second.video.metadata.transcriptionRun.id,
			),
		).toMatchObject({ state: "ready" });
	});
	it("the workflow explicitly queues current media after the early-segment proof changes", async () => {
		const claim = await claimTranscriptionRun(
			fixture.database,
			video.id,
			video.ownerId,
			{ earlyFromSegments: true },
		);
		if (!claim) throw new Error("Claim missing");
		await fixture.database
			.update(videos)
			.set({
				source: {
					type: "desktopMP4",
					outputKey: `${video.ownerId}/${video.id}/new-mux.mp4`,
				},
				duration: 10.2,
			})
			.where(eq(videos.id, video.id));
		const result = await transcribeVideoWorkflow({
			videoId: video.id,
			userId: video.ownerId,
			runId: claim.video.metadata.transcriptionRun.id,
			aiGenerationEnabled: false,
			earlyFromSegments: true,
		});
		expect(result.success).toBe(true);
		expect(state.transcribe).not.toHaveBeenCalled();
		expect(state.dispatch).toHaveBeenCalledTimes(1);
		const dispatched = state.dispatch.mock
			.calls[0]?.[1] as typeof videos.$inferSelect;
		expect(dispatched.source.type).toBe("desktopMP4");
		expect(dispatched.metadata?.transcriptionRun?.id).not.toBe(
			claim.video.metadata.transcriptionRun.id,
		);
	});
});
