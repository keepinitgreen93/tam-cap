export function normalizeApiBaseUrl(value: string) {
	const url = new URL(value.trim());
	const loopback = ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname);
	if (
		(url.protocol !== "https:" && !(url.protocol === "http:" && loopback)) ||
		url.username ||
		url.password ||
		url.search ||
		url.hash ||
		url.pathname !== "/"
	) {
		throw new Error(
			"Use an HTTPS instance URL, or HTTP localhost for development",
		);
	}
	return url.origin;
}

export const productionApiBaseUrl = normalizeApiBaseUrl(
	import.meta.env.VITE_CAP_API_BASE_URL ||
		"https://videos.trulyauthenticmarketing.com",
);

export const defaultApiBaseUrl =
	import.meta.env.MODE === "development" &&
	!import.meta.env.VITE_CAP_API_BASE_URL
		? "http://localhost:3000"
		: productionApiBaseUrl;

export function isInstanceOrigin(
	value: string,
	apiBaseUrl = defaultApiBaseUrl,
) {
	try {
		return new URL(value).origin === normalizeApiBaseUrl(apiBaseUrl);
	} catch {
		return false;
	}
}
