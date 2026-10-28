import { describe, expect, it } from "vitest";
import { normalizeVideoFps } from "@/lib/video-metadata";

describe("stored video frame rate", () => {
	it.each([
		[25.06, 25],
		[29.97, 30],
		[59.94, 60],
		[30, 30],
		[0, 0],
	])("rounds only the persisted frame rate %s", (fps, expected) => {
		const probe = { fps, duration: 19.198 };
		expect(normalizeVideoFps(probe.fps)).toBe(expected);
		expect(probe).toEqual({ fps, duration: 19.198 });
	});
	it.each([null, undefined])("preserves absent metadata %s", (fps) => {
		expect(normalizeVideoFps(fps)).toBe(fps);
	});
	it.each([Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY])(
		"rejects a non-finite frame rate %s",
		(fps) => {
			expect(() => normalizeVideoFps(fps)).toThrow("must be finite");
		},
	);
});
