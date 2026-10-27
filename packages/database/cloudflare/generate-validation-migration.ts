import { readFile, writeFile } from "node:fs/promises";
import {
	buildValidationMigration,
	buildValidationPreflight,
	readValidationContract,
} from "./validation-contract.ts";

const contract = await readValidationContract();
const artifacts = [
	{
		file: "./migrations/0002_d1_validation.sql",
		contents: buildValidationMigration(contract),
	},
	{
		file: "./validation-preflight.sql",
		contents: buildValidationPreflight(contract),
	},
];
for (const artifact of artifacts) {
	const destination = new URL(artifact.file, import.meta.url);
	if (process.argv.includes("--check")) {
		if (
			(await readFile(destination, "utf8")).replaceAll("\r\n", "\n") !==
			artifact.contents
		)
			throw new Error(
				`${artifact.file} is out of date; regenerate before deployment.`,
			);
	} else await writeFile(destination, artifact.contents);
}
