import assert from "node:assert/strict";
import { createRequire } from "node:module";
import test from "node:test";
import { z as esm } from "zod";
import { z as compatibility } from "zod/v3";

const require = createRequire(import.meta.url);
const { z: commonjs } = require("zod");

for (const [entrypoint, z] of Object.entries({
	esm,
	compatibility,
	commonjs,
})) {
	for (const bound of ["max", "length"]) {
		for (const async of [false, true]) {
			test(`${entrypoint}: oversized array ${bound} rejects before element parsing (${async ? "async" : "sync"})`, async () => {
				let visited = 0;
				const element = z.preprocess((value) => {
					visited++;
					return value;
				}, z.string());
				const schema = z.object({ values: z.array(element)[bound](2) });
				const input = { values: [1, 2, 3] };
				const result = async
					? await schema.safeParseAsync(input)
					: schema.safeParse(input);
				assert.equal(visited, 0);
				assert.equal(result.success, false);
				assert.equal(result.error.issues.length, 1);
				assert.equal(result.error.issues[0].code, "too_big");
				assert.deepEqual(result.error.issues[0].path, ["values"]);
			});
		}
	}

	test(`${entrypoint}: oversized sets reject before element parsing`, async () => {
		let visited = 0;
		const element = z.preprocess((value) => {
			visited++;
			return value;
		}, z.string());
		for (const bound of ["max", "size"]) {
			const schema = z.set(element)[bound](2);
			for (const result of [
				schema.safeParse(new Set([1, 2, 3])),
				await schema.safeParseAsync(new Set([1, 2, 3])),
			]) {
				assert.equal(visited, 0);
				assert.equal(result.success, false);
				assert.equal(result.error.issues.length, 1);
				assert.equal(result.error.issues[0].code, "too_big");
			}
		}
	});

	test(`${entrypoint}: valid collections and lower-bound validation preserve behavior`, () => {
		const schema = z.array(
			z.string().transform((value) => value.toUpperCase()),
		);
		assert.deepEqual(schema.max(2).parse(["a", "b"]), ["A", "B"]);
		assert.deepEqual(schema.length(2).parse(["a", "b"]), ["A", "B"]);
		assert.deepEqual(
			z
				.set(z.string())
				.max(2)
				.parse(new Set(["a"])),
			new Set(["a"]),
		);
		const result = schema.min(2).safeParse([1]);
		assert.equal(result.success, false);
		assert.deepEqual(
			result.error.issues.map((issue) => issue.code),
			["too_small", "invalid_type"],
		);
	});
}
