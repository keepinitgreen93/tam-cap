import { Video } from "@cap/web-domain";
import { Effect } from "effect";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
	rows: [] as unknown[][],
	sign: vi.fn(),
	access: vi.fn(),
	userId: "owner",
}));

vi.mock("@cap/database/cloudflare/application", () => ({
	db: () => ({
		select: () => ({
			from: () => ({ where: () => Promise.resolve(mocks.rows.shift() ?? []) }),
		}),
	}),
}));
vi.mock("@cap/database/auth/session", () => ({
	getCurrentUser: () => Promise.resolve({ id: mocks.userId }),
}));
vi.mock("@cap/web-backend", () => ({
	Storage: { getAccessForVideo: mocks.access },
}));
vi.mock("@/lib/video-download-permissions", () => ({
	canUserDownloadVideo: () => Promise.resolve(true),
}));
vi.mock("@/lib/server", () => ({ runPromise: Effect.runPromise }));

import {
	getVideoDownloadInfo,
	type VideoDownloadVariant,
} from "@/actions/videos/download";

describe("current video download", () => {
	beforeEach(() => {
		mocks.rows = [];
		mocks.userId = "owner";
		mocks.sign.mockReset();
		mocks.access.mockReset();
	});

	it("does not issue an original capability to a shared reader", async () => {
		mocks.userId = "reader";
		mocks.rows = [
			[
				{
					id: "video",
					ownerId: "owner",
					orgId: "organization",
					name: "Edited recording",
					public: true,
					source: { type: "webMP4" },
					metadata: null,
					bucket: null,
					storageIntegrationId: null,
					folderId: null,
					transcriptionStatus: null,
					width: null,
					height: null,
					duration: 10,
					createdAt: new Date(),
					updatedAt: new Date(),
				},
			],
			[{ sourceKey: "owner/video/.recording/sources/original.mp4" }],
		];
		mocks.sign.mockReturnValue(
			Effect.succeed("https://media.example/original"),
		);
		mocks.access.mockReturnValue(
			Effect.succeed([
				{
					headObject: () => Effect.succeed({}),
					getSignedObjectUrl: mocks.sign,
				},
			]),
		);
		await expect(
			getVideoDownloadInfo(Video.VideoId.make("video"), "original"),
		).rejects.toThrow(/permission/);
		expect(mocks.access).not.toHaveBeenCalled();
		expect(mocks.sign).not.toHaveBeenCalled();
	});

	it.each(["unexpected", null, {}, 42])(
		"rejects an untrusted download variant %j before storage access",
		async (variant) => {
			await expect(
				getVideoDownloadInfo(
					Video.VideoId.make("video"),
					variant as unknown as VideoDownloadVariant,
				),
			).rejects.toThrow("Invalid video download variant");
			expect(mocks.access).not.toHaveBeenCalled();
			expect(mocks.sign).not.toHaveBeenCalled();
		},
	);

	it.each(["current", "original"] as const)(
		"signs the %s MP4 key",
		async (variant) => {
			const outputKey = "owner/video/.recording/outputs/generation/result.mp4";
			const originalKey = "owner/video/.recording/sources/original.mp4";
			mocks.rows = [
				[
					{
						id: "video",
						ownerId: "owner",
						orgId: "organization",
						name: "Recording",
						public: true,
						source: { type: "desktopMP4", outputKey },
						metadata: null,
						bucket: "custom-bucket",
						storageIntegrationId: null,
						folderId: null,
						transcriptionStatus: null,
						width: null,
						height: null,
						duration: null,
						createdAt: new Date(),
						updatedAt: new Date(),
					},
				],
				variant === "current" ? [] : [{ sourceKey: originalKey }],
			];
			mocks.sign.mockReturnValue(
				Effect.succeed("https://media.example.com/video.mp4"),
			);
			mocks.access.mockReturnValue(
				Effect.succeed([
					{
						headObject: () => Effect.succeed({}),
						getSignedObjectUrl: mocks.sign,
					},
				]),
			);

			expect(
				await getVideoDownloadInfo(Video.VideoId.make("video"), variant),
			).toMatchObject({
				success: true,
			});
			expect(mocks.sign).toHaveBeenCalledExactlyOnceWith(
				variant === "current" ? outputKey : originalKey,
			);
		},
	);
});
