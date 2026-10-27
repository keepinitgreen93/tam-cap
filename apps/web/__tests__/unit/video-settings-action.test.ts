import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
	updates: [] as unknown[],
}));

vi.mock("@cap/database/auth/session", () => ({
	getCurrentUser: async () => ({ id: "owner" }),
}));

vi.mock("@cap/database/cloudflare/application", async () => {
	const schema = await import("@cap/database/cloudflare/schema");
	const { createRecordingD1Model } = await import(
		"../helpers/recording-d1-model"
	);
	const database = createRecordingD1Model({
		read: ({ table }) => {
			if (table === schema.videos)
				return [{ id: "video", ownerId: "owner", orgId: "org" }];
			if (table === schema.organizations)
				return [{ id: "org", ownerId: "owner", tombstoneAt: null }];
			return [];
		},
		apply: (statements) => {
			for (const item of statements)
				if (item.table === schema.videos) mocks.updates.push(item.values);
		},
	});
	return { db: () => database };
});

import type { Video } from "@cap/web-domain";
import { updateVideoSettings } from "@/actions/videos/settings";

const patchOf = (value: unknown): Record<string, unknown> => {
	const chunks = (value as { queryChunks?: unknown[] }).queryChunks ?? [];
	const json = chunks.find(
		(chunk): chunk is string =>
			typeof chunk === "string" && chunk.startsWith("{"),
	);
	return JSON.parse(json ?? "{}");
};

describe("updateVideoSettings", () => {
	beforeEach(() => {
		mocks.updates = [];
	});

	it("merges only known viewer settings", async () => {
		await updateVideoSettings(
			"video" as Video.VideoId,
			{
				disableComments: true,
				defaultPlaybackSpeed: 1.49,
				callToAction: { label: "x", url: "javascript:alert(1)" },
			} as Parameters<typeof updateVideoSettings>[1],
		);

		const settings = (mocks.updates[0] as { settings: unknown }).settings;
		expect(patchOf(settings)).toEqual({
			disableComments: true,
			defaultPlaybackSpeed: 1.5,
		});
	});
});
