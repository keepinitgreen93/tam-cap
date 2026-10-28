import assert from "node:assert/strict";
import test from "node:test";
import { applicationHeaders } from "./request-headers.ts";

test("Cloudflare client IP replaces spoofed forwarding aliases", () => {
	for (const ip of ["203.0.113.1", "2001:db8::1"]) {
		const request = new Request("https://cap.example", {
			headers: {
				"cf-connecting-ip": ip,
				"x-forwarded-for": "198.51.100.1, 203.0.113.1",
				"x-real-ip": "198.51.100.2",
				"x-client-ip": "198.51.100.3",
				"true-client-ip": "198.51.100.4",
				"x-vercel-forwarded-for": "198.51.100.5",
				forwarded: "for=198.51.100.6",
			},
		});
		const headers = applicationHeaders(request);
		assert.equal(headers.get("x-forwarded-for"), ip);
		assert.equal(headers.get("x-real-ip"), ip);
		assert.equal(headers.get("cf-connecting-ip"), ip);
		for (const alias of [
			"x-client-ip",
			"true-client-ip",
			"x-vercel-forwarded-for",
			"forwarded",
		])
			assert.equal(headers.get(alias), null);
	}
});

test("missing or malformed Cloudflare client IP never trusts caller aliases", () => {
	for (const clientIp of [undefined, "untrusted", "1".repeat(65)]) {
		const headers = new Headers({
			"x-forwarded-for": "spoof",
			"x-real-ip": "spoof",
			forwarded: "for=spoof",
		});
		if (clientIp) headers.set("cf-connecting-ip", clientIp);
		const result = applicationHeaders(
			new Request("https://cap.example", { headers }),
		);
		for (const name of [
			"cf-connecting-ip",
			"x-forwarded-for",
			"x-real-ip",
			"forwarded",
		])
			assert.equal(result.get(name), null);
	}
});

test("only trusted edge metadata supplies analytics geography", () => {
	const request = new Request("https://cap.example", {
		headers: {
			"x-cap-geo-country": "attacker",
			"x-cap-geo-region": "attacker",
			"x-cap-geo-city": "attacker",
			"x-cap-geo-extra": "attacker",
			"x-cap-preview-key": "private",
			cookie: "session=test",
		},
	});
	const headers = applicationHeaders(request, {
		country: "CA",
		region: "Québec",
		city: "Montréal",
	});
	assert.equal(headers.get("x-cap-geo-country"), "CA");
	assert.equal(decodeURIComponent(headers.get("x-cap-geo-region")), "Québec");
	assert.equal(decodeURIComponent(headers.get("x-cap-geo-city")), "Montréal");
	assert.equal(headers.get("x-cap-geo-extra"), null);
	assert.equal(headers.get("x-cap-preview-key"), null);
	assert.equal(headers.get("cookie"), "session=test");
});

test("missing or malformed trusted geography never preserves user-supplied values", () => {
	for (const cf of [
		undefined,
		{ country: "US\nspoof", region: 12, city: "a".repeat(257) },
	]) {
		const headers = applicationHeaders(
			new Request("https://cap.example", {
				headers: { "x-cap-geo-city": "spoof" },
			}),
			cf,
		);
		assert.equal(
			[...headers.keys()].some((key) => key.startsWith("x-cap-geo-")),
			false,
		);
	}
});
