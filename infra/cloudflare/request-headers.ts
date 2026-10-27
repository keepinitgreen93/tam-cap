export function applicationHeaders(request: Request, geography?: unknown) {
	const headers = new Headers(request.headers);
	for (const key of [...headers.keys()]) {
		if (key === "x-cap-preview-key" || key.startsWith("x-cap-geo-"))
			headers.delete(key);
	}
	for (const field of ["country", "region", "city"] as const) {
		const value =
			geography && typeof geography === "object" && field in geography
				? (geography as Record<string, unknown>)[field]
				: undefined;
		if (
			typeof value === "string" &&
			value.length > 0 &&
			value.length <= 256 &&
			![...value].some((character) => {
				const code = character.charCodeAt(0);
				return code < 32 || code === 127;
			})
		) {
			headers.set(`x-cap-geo-${field}`, encodeURIComponent(value));
		}
	}
	return headers;
}
