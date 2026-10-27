import assert from "node:assert/strict";
import test from "node:test";
import { applicationHeaders } from "./request-headers.ts";

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
