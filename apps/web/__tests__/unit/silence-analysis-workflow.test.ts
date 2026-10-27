import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
	load: vi.fn(),
	read: vi.fn(),
	update: vi.fn(),
	put: vi.fn(),
	fetch: vi.fn(),
}));
vi.mock("@cap/env", () => ({
	serverEnv: () => ({
		MEDIA_SERVER_URL: "http://cap.media",
		MEDIA_SERVER_WEBHOOK_SECRET: "test-secret",
	}),
}));
vi.mock("@/lib/silence-analysis-storage", () => ({
	loadSilenceSource: mocks.load,
	readSilenceResult: mocks.read,
	updateSilenceClaim: mocks.update,
}));
vi.mock("@/lib/workflow-runtime", () => ({
	runWorkflowPromise: (value: unknown) => value,
}));

import { silenceAnalysisWorkflow } from "@/workflows/silence-analysis";

const revision = "a".repeat(64);
const payload = {
	videoId: "video-1",
	ownerId: "owner-1",
	revision,
	requestId: "67e55044-10b1-426f-9247-bb680e5fe0c8",
};
const result = {
	version: 1,
	profile: "pcm-quiet-v1",
	durationMs: 4000,
	audioTracks: 1,
	ranges: [{ startMs: 1000, endMs: 2000 }],
};
const source = {
	video: {
		metadata: {
			silenceAnalysis: {
				revision,
				requestId: payload.requestId,
				requestedAt: 1000,
				runId: "run-1",
				status: "processing",
			},
		},
	},
	revision,
	durationMs: 4000,
	contentLength: 2,
	key: "owner-1/video-1/result.mp4",
	identity: '"object-1"',
	resultKey: `owner-1/video-1/.recording/silence/${revision}.json`,
	bucket: {
		provider: "s3",
		getInternalSignedObjectUrl: () => ({
			pipe: () => Promise.resolve("https://authorized-bucket/source"),
		}),
		putObject: mocks.put,
	},
};

beforeEach(() => {
	vi.stubGlobal("fetch", mocks.fetch);
	mocks.load.mockResolvedValue(source);
	mocks.read.mockResolvedValue(null);
	mocks.update.mockResolvedValue(true);
	mocks.put.mockReturnValue({ pipe: () => Promise.resolve() });
	mocks.fetch.mockImplementation((url: string) =>
		Promise.resolve(
			url.includes("authorized-bucket")
				? new Response(new Uint8Array([1, 2]), {
						headers: { etag: '"object-1"' },
					})
				: Response.json(result),
		),
	);
});
afterEach(() => vi.unstubAllGlobals());

describe("durable silence analysis", () => {
	it("sends only a small authorized R2 descriptor across the Cloudflare proxy", async () => {
		const url = `https://${"a".repeat(32)}.r2.cloudflarestorage.com/bucket/owner-1/video-1/result.mp4?X-Amz-Algorithm=AWS4-HMAC-SHA256&X-Amz-Signature=${"b".repeat(64)}`;
		mocks.load.mockResolvedValue({
			...source,
			bucket: {
				...source.bucket,
				getInternalSignedObjectUrl: () => ({
					pipe: () => Promise.resolve(url),
				}),
			},
		});
		expect(await silenceAnalysisWorkflow(payload)).toEqual({ success: true });
		expect(mocks.fetch).toHaveBeenCalledTimes(1);
		expect(mocks.fetch).toHaveBeenCalledWith(
			"http://cap.media/silence-analysis",
			expect.objectContaining({
				headers: {
					"content-type": "application/json",
					"x-media-server-secret": "test-secret",
				},
				body: JSON.stringify({
					url,
					objectPrefix: "owner-1/video-1/",
					identity: source.identity,
					durationMs: 4000,
					contentLength: 2,
				}),
			}),
		);
	});
	it("streams only the revision-checked authorized object and persists before marking ready", async () => {
		expect(await silenceAnalysisWorkflow(payload)).toEqual({ success: true });
		expect(mocks.fetch).toHaveBeenNthCalledWith(
			1,
			"https://authorized-bucket/source",
			expect.objectContaining({
				headers: { "If-Match": '"object-1"' },
				redirect: "error",
			}),
		);
		expect(mocks.fetch).toHaveBeenNthCalledWith(
			2,
			"http://cap.media/silence-analysis",
			expect.objectContaining({
				method: "POST",
				body: expect.any(ReadableStream),
			}),
		);
		expect(mocks.put).toHaveBeenCalledWith(
			source.resultKey,
			JSON.stringify(result),
			{ contentType: "application/json" },
		);
		expect(mocks.put.mock.invocationCallOrder[0]).toBeLessThan(
			mocks.update.mock.invocationCallOrder[0] ?? 0,
		);
		expect(mocks.update).toHaveBeenLastCalledWith(
			"video-1",
			"owner-1",
			payload.requestId,
			{ status: "ready" },
		);
	});
	it("reuses the immutable revision result on workflow retry", async () => {
		mocks.read.mockResolvedValue(result);
		expect(await silenceAnalysisWorkflow(payload)).toEqual({ success: true });
		expect(mocks.fetch).not.toHaveBeenCalled();
		expect(mocks.put).not.toHaveBeenCalled();
	});
	it("rejects a source that changes between HEAD and GET", async () => {
		mocks.fetch.mockResolvedValue(
			new Response(new Uint8Array([1]), { headers: { etag: '"different"' } }),
		);
		expect(await silenceAnalysisWorkflow(payload)).toEqual({ success: false });
		expect(mocks.fetch).toHaveBeenCalledTimes(1);
		expect(mocks.put).not.toHaveBeenCalled();
	});
	it("does not publish an analysis after ownership or revision changes", async () => {
		mocks.load
			.mockResolvedValueOnce(source)
			.mockRejectedValueOnce(new Error("Owner changed"));
		expect(await silenceAnalysisWorkflow(payload)).toEqual({ success: false });
		expect(mocks.put).not.toHaveBeenCalled();
		mocks.load
			.mockResolvedValueOnce(source)
			.mockResolvedValueOnce({ ...source, revision: "b".repeat(64) });
		expect(await silenceAnalysisWorkflow(payload)).toEqual({ success: false });
		expect(mocks.put).not.toHaveBeenCalled();
	});
	it("does not mark ready when private result persistence fails", async () => {
		mocks.put.mockReturnValue({
			pipe: () => Promise.reject(new Error("R2 unavailable")),
		});
		expect(await silenceAnalysisWorkflow(payload)).toEqual({ success: false });
		expect(mocks.update).toHaveBeenLastCalledWith(
			"video-1",
			"owner-1",
			payload.requestId,
			{ status: "error" },
		);
	});
});
