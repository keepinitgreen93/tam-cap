export function normalizeVideoFps(value: number): number;
export function normalizeVideoFps(
	value: number | null | undefined,
): number | null | undefined;
export function normalizeVideoFps(value: number | null | undefined) {
	if (value === null || value === undefined) return value;
	if (!Number.isFinite(value))
		throw new Error("Video frame rate must be finite");
	return Math.round(value);
}
