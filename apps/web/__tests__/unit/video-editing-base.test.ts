import { expect, it } from "vitest";
import { getEditSourceKey, isEditSourceKey } from "@/lib/video-edit-processing";
import { getVideoEditingBase } from "@/lib/video-editing-base";

const video = { id: "video", ownerId: "owner" };
const base = {
	version: 1 as const,
	id: "9379e503-fbd2-4f34-a509-42d954f1da85",
	sourceKey: "owner/video/.recording/outputs/replacement/result.mp4",
	duration: 30,
};

it("selects a declared immutable editing base and recognizes its upload context", () => {
	const metadata = { editingBase: base };
	expect(getVideoEditingBase({ ...video, metadata })).toEqual(base);
	expect(getEditSourceKey(video.ownerId, video.id, metadata)).toBe(
		base.sourceKey,
	);
	expect(
		isEditSourceKey({
			ownerId: video.ownerId,
			videoId: video.id,
			rawFileKey: base.sourceKey,
			metadata,
		}),
	).toBe(true);
	expect(
		isEditSourceKey({
			ownerId: video.ownerId,
			videoId: video.id,
			rawFileKey: "owner/video/source/original.mp4",
			metadata,
		}),
	).toBe(false);
});
it("keeps legacy canonical originals only when no base is declared", () => {
	expect(getVideoEditingBase(video)).toBeNull();
	expect(getEditSourceKey(video.ownerId, video.id)).toBe(
		"owner/video/source/original.mp4",
	);
});
it.each([
	null,
	{ ...base, sourceKey: "other/video/.recording/result.mp4" },
	{ ...base, sourceKey: "owner/other/.recording/result.mp4" },
	{ ...base, sourceKey: "owner/video/.recording/../result.mp4" },
	{ ...base, sourceKey: "owner/video/.recording/%2e%2e/result.mp4" },
	{ ...base, sourceKey: "owner/video/source/original.mp4" },
	{ ...base, duration: 0 },
])(
	"rejects an invalid declared base without falling back to old bytes (%#)",
	(editingBase) => {
		expect(() =>
			getVideoEditingBase({ ...video, metadata: { editingBase } }),
		).toThrow("Video editing base is invalid");
	},
);
