import { describe, expect, it } from "vitest";
import {
	defaultApiBaseUrl,
	isInstanceOrigin,
	normalizeApiBaseUrl,
	productionApiBaseUrl,
} from "./instance";

describe("self-hosted instance configuration", () => {
	it("uses the team instance without a Cap Cloud fallback", () => {
		expect(productionApiBaseUrl).toBe(
			"https://videos.trulyauthenticmarketing.com",
		);
		expect(defaultApiBaseUrl).not.toContain("cap.so");
	});
	it("normalizes HTTPS origins and permits local HTTP test instances", () => {
		expect(normalizeApiBaseUrl(" https://videos.example.com/ ")).toBe(
			"https://videos.example.com",
		);
		expect(normalizeApiBaseUrl("http://127.0.0.1:4000")).toBe(
			"http://127.0.0.1:4000",
		);
	});
	it.each([
		"http://example.com",
		"https://user:password@example.com",
		"https://example.com/path",
		"https://example.com/?key=value",
		"https://example.com/#token",
		"file:///tmp",
		"javascript:alert(1)",
	])("rejects an unsafe or ambiguous API URL %s", (value) => {
		expect(() => normalizeApiBaseUrl(value)).toThrow();
	});
	it("recognizes exactly the configured web origin", () => {
		expect(
			isInstanceOrigin(
				"https://videos.example.com/dashboard",
				"https://videos.example.com",
			),
		).toBe(true);
		for (const value of [
			"https://evil.videos.example.com",
			"http://videos.example.com",
			"https://videos.example.com.evil.test",
			"https://cap.so",
		])
			expect(isInstanceOrigin(value, "https://videos.example.com")).toBe(false);
	});
});
