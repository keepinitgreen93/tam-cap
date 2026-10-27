import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
	user: vi.fn(),
	load: vi.fn(),
	read: vi.fn(),
	update: vi.fn(),
	start: vi.fn(),
	getRun: vi.fn(),
	db: vi.fn(),
	atomic: vi.fn(),
}));
vi.mock("@cap/database/auth/session", () => ({ getCurrentUser: mocks.user }));
vi.mock("@cap/database/cloudflare/application", () => ({ db: mocks.db }));
vi.mock("@cap/database/cloudflare/atomic", () => ({ atomic: mocks.atomic }));
vi.mock("@cap/database/cloudflare/schema", () => ({
	videos: { id: "video.id" },
}));
vi.mock("@cap/utils", () => ({ userIsPro: () => true }));
vi.mock("drizzle-orm", () => ({ eq: () => "condition" }));
vi.mock("workflow/api", () => ({ start: mocks.start, getRun: mocks.getRun }));
vi.mock("@/workflows/silence-analysis", () => ({
	silenceAnalysisWorkflow: vi.fn(),
}));
vi.mock("@/lib/silence-analysis-storage", () => ({
	loadSilenceSource: mocks.load,
	readSilenceResult: mocks.read,
	updateSilenceClaim: mocks.update,
}));

import { Video } from "@cap/web-domain";
import {
	getSilenceAnalysis,
	requestSilenceAnalysis,
} from "@/actions/videos/silence-analysis";

const videoId = Video.VideoId.make("video-1");
const revision = "a".repeat(64);
type VideoRow = {
	id: string;
	ownerId: string;
	metadata: Record<string, unknown>;
};
let video: VideoRow;
const database = {
	select: () => ({ from: () => ({ where: () => Promise.resolve([video]) }) }),
	update: () => ({
		set: (update: { metadata: Record<string, unknown> }) => ({
			where: () => ({
				apply: () => {
					video = { ...video, ...update };
				},
			}),
		}),
	}),
};
type Plan = (snapshot: {
	read: (
		query: (value: typeof database) => PromiseLike<VideoRow[]>,
	) => PromiseLike<VideoRow[]>;
}) => Promise<{ statements: { apply: () => void }[]; result: boolean }>;

beforeEach(() => {
	video = {
		id: videoId,
		ownerId: "owner-1",
		metadata: { unrelated: "preserve" },
	};
	mocks.user.mockResolvedValue({ id: "owner-1" });
	mocks.load.mockImplementation(async () => ({
		video,
		revision,
		durationMs: 4000,
	}));
	mocks.read.mockResolvedValue(null);
	mocks.start.mockResolvedValue({ runId: "run-1" });
	mocks.getRun.mockReturnValue({ status: Promise.resolve("running") });
	mocks.db.mockReturnValue(database);
	mocks.update.mockResolvedValue(true);
	let queue = Promise.resolve(false);
	mocks.atomic.mockImplementation((_db: unknown, planner: Plan) => {
		queue = queue.then(async () => {
			const plan = await planner({ read: (query) => query(database) });
			for (const statement of plan.statements) statement.apply();
			return plan.result;
		});
		return queue;
	});
});

describe("owner-scoped silence actions", () => {
	it("bounds repeated retries after a processing failure", async () => {
		video.metadata.silenceAnalysis = {
			revision,
			requestId: "67e55044-10b1-426f-9247-bb680e5fe0c8",
			requestedAt: Date.now(),
			runId: "run-failed",
			status: "error",
		};
		expect((await requestSilenceAnalysis(videoId, revision)).status).toBe(
			"error",
		);
		expect(mocks.start).not.toHaveBeenCalled();
	});
	it("deduplicates concurrent starts using the atomic metadata claim", async () => {
		const replies = await Promise.all([
			requestSilenceAnalysis(videoId, revision),
			requestSilenceAnalysis(videoId, revision),
		]);
		expect(replies.every((reply) => reply.status === "processing")).toBe(true);
		expect(mocks.start).toHaveBeenCalledTimes(1);
		expect(video.metadata.unrelated).toBe("preserve");
		expect(mocks.load).toHaveBeenCalledWith(videoId, "owner-1");
	});
	it("blocks unauthenticated callers before accessing any video or storage", async () => {
		mocks.user.mockResolvedValue(null);
		expect((await requestSilenceAnalysis(videoId, revision)).status).toBe(
			"error",
		);
		expect((await getSilenceAnalysis(videoId, revision)).status).toBe("error");
		expect(mocks.load).not.toHaveBeenCalled();
		expect(mocks.start).not.toHaveBeenCalled();
	});
	it("rejects stale editor revisions before starting work", async () => {
		expect((await requestSilenceAnalysis(videoId, "b".repeat(64))).status).toBe(
			"error",
		);
		expect(mocks.atomic).not.toHaveBeenCalled();
		expect(mocks.start).not.toHaveBeenCalled();
	});
	it("reuses completed revision results", async () => {
		mocks.read.mockResolvedValue({
			version: 1,
			profile: "pcm-quiet-v1",
			durationMs: 4000,
			audioTracks: 1,
			ranges: [],
		});
		expect((await requestSilenceAnalysis(videoId, revision)).status).toBe(
			"ready",
		);
		expect(mocks.start).not.toHaveBeenCalled();
	});
	it("keeps an uncertain startup lease instead of immediately spawning another job", async () => {
		mocks.start.mockRejectedValue(new Error("Response lost"));
		expect((await requestSilenceAnalysis(videoId, revision)).status).toBe(
			"error",
		);
		expect((await requestSilenceAnalysis(videoId, revision)).status).toBe(
			"processing",
		);
		expect(mocks.start).toHaveBeenCalledTimes(1);
	});
});
