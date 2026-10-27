import { Video } from "@cap/web-domain";
import { QueryClient } from "@tanstack/react-query";
import { Effect } from "effect";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
	rows: [] as Record<string, unknown>[],
	allowed: true,
	configured: false,
	aiConfigured: false,
	read: vi.fn(),
	transcribe: vi.fn(),
	generate: vi.fn(),
}));

vi.mock("@cap/database/cloudflare/application", async () => {
	const schema = await import("@cap/database/cloudflare/schema");
	return {
		db: () => ({
			select: () => ({
				from: (table: unknown) => ({
					where: () => {
						const result = Promise.resolve(
							table === schema.videoUploads
								? []
								: table === schema.users
									? [{ email: "fixture@example.com" }]
									: mocks.rows,
						);
						mocks.read();
						return Object.assign(result, { limit: () => result });
					},
				}),
			}),
		}),
	};
});
vi.mock("@cap/env", () => ({
	serverEnv: () => ({
		ASSEMBLY_API_KEY: mocks.configured ? "synthetic" : undefined,
	}),
}));
vi.mock("@cap/web-backend", async () => {
	const { Effect } = await import("effect");
	const { Policy } = await import("@cap/web-domain");
	class VideosPolicy extends Effect.Service<VideosPolicy>()("VideosPolicy", {
		sync: () => ({
			canView: () =>
				mocks.allowed
					? Effect.void
					: Effect.fail(new Policy.PolicyDeniedError()),
		}),
	}) {}
	return {
		VideosPolicy,
		provideOptionalAuth: Effect.provide(VideosPolicy.Default),
	};
});
vi.mock("@/lib/server", () => ({ runPromiseExit: Effect.runPromiseExit }));
vi.mock("@/lib/ai/provider", () => ({
	isAiConfigured: () => mocks.aiConfigured,
}));
vi.mock("@/lib/desktop-segments-finalization", () => ({
	isRetryableDesktopSegmentsFinalizationError: () => false,
	queueDesktopSegmentsFinalization: vi.fn(),
}));
vi.mock("@/lib/generate-ai", () => ({ startAiGeneration: mocks.generate }));
vi.mock("@/lib/transcribe", () => ({ transcribeVideo: mocks.transcribe }));
vi.mock("@/utils/flags", () => ({ isAiGenerationEnabled: () => true }));

const { getVideoStatus } = await import("@/actions/videos/get-status");
const { videoStatusQueryOptions, VideoStatusNotFoundError } = await import(
	"@/lib/video-status-query"
);
const videoId = Video.VideoId.make("missing-video");

beforeEach(() => {
	mocks.rows = [];
	mocks.allowed = true;
	mocks.configured = false;
	mocks.aiConfigured = false;
	mocks.transcribe.mockReset().mockResolvedValue({ success: true });
	mocks.generate.mockReset().mockResolvedValue({ success: true });
});

describe("video status", () => {
	it("returns an expected missing result without triggering processing", async () => {
		await expect(getVideoStatus(videoId)).resolves.toEqual({
			success: false,
			reason: "not_found",
		});
		expect(mocks.transcribe).not.toHaveBeenCalled();
		expect(mocks.generate).not.toHaveBeenCalled();
	});

	it("keeps access denial separate from a missing video", async () => {
		mocks.allowed = false;
		await expect(getVideoStatus(videoId)).resolves.toEqual({ success: false });
		expect(mocks.read).not.toHaveBeenCalled();
	});

	it("preserves metadata for an available video", async () => {
		mocks.rows = [{ name: "Recording", transcriptionStatus: "COMPLETE" }];
		await expect(getVideoStatus(videoId)).resolves.toMatchObject({
			name: "Recording",
			transcriptionStatus: "COMPLETE",
		});
	});

	it("waits for durable transcription dispatch before reporting processing", async () => {
		mocks.configured = true;
		mocks.rows = [
			{ ownerId: "owner", name: "Recording", transcriptionStatus: null },
		];
		let release: (() => void) | undefined;
		let settled = false;
		mocks.transcribe.mockImplementationOnce(
			() =>
				new Promise((resolve) => {
					release = () => resolve({ success: true });
				}),
		);
		const result = getVideoStatus(videoId).then((value) => {
			settled = true;
			return value;
		});
		await vi.waitFor(() => expect(mocks.transcribe).toHaveBeenCalledTimes(1));
		expect(settled).toBe(false);
		release?.();
		expect(await result).toMatchObject({ transcriptionStatus: "PROCESSING" });
	});
	it("resumes uncertain transcription and AI receipts through the dispatcher", async () => {
		mocks.configured = true;
		mocks.rows = [
			{
				ownerId: "owner",
				name: "Recording",
				transcriptionStatus: "PROCESSING",
				metadata: { transcriptionRun: { dispatch: "uncertain" } },
			},
		];
		await getVideoStatus(videoId);
		expect(mocks.transcribe).toHaveBeenCalledTimes(1);
		mocks.aiConfigured = true;
		mocks.rows = [
			{
				ownerId: "owner",
				name: "Recording",
				transcriptionStatus: "COMPLETE",
				metadata: {
					aiGenerationStatus: "QUEUED",
					aiGenerationRun: { dispatch: "uncertain" },
				},
			},
		];
		await getVideoStatus(videoId);
		expect(mocks.generate).toHaveBeenCalledTimes(1);
	});

	it("does not retry missing videos even when initial data is cached", async () => {
		const client = new QueryClient();
		const options = videoStatusQueryOptions(videoId);
		client.setQueryData(options.queryKey, { name: "Old recording" });
		await expect(
			client.fetchQuery({ ...options, retryDelay: 0 }),
		).rejects.toBeInstanceOf(VideoStatusNotFoundError);
		expect(mocks.read).toHaveBeenCalledTimes(1);
		client.clear();
	});

	it("still retries other failures", async () => {
		const client = new QueryClient();
		let attempts = 0;
		const result = await client.fetchQuery({
			...videoStatusQueryOptions(videoId),
			retryDelay: 0,
			queryFn: async () => {
				attempts++;
				if (attempts < 3) throw new TypeError("Failed to fetch");
				return "recovered";
			},
		});
		expect(result).toBe("recovered");
		expect(attempts).toBe(3);
		client.clear();
	});
});
