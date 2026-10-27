import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import ts from "typescript";

const root = "apps/web";
const manifest = JSON.parse(
	readFileSync(join(root, "app/.well-known/workflow/v1/manifest.json"), "utf8"),
);
const missing = [];
let expected = 0;
for (const file of readdirSync(join(root, "workflows"))) {
	if (!file.endsWith(".ts")) continue;
	const source = ts.createSourceFile(
		file,
		readFileSync(join(root, "workflows", file), "utf8"),
		ts.ScriptTarget.Latest,
		true,
	);
	for (const node of source.statements) {
		if (!ts.isFunctionDeclaration(node) || !node.name || !node.body) continue;
		const directive = node.body.statements[0];
		if (
			!directive ||
			!ts.isExpressionStatement(directive) ||
			!ts.isStringLiteral(directive.expression) ||
			directive.expression.text !== "use workflow"
		)
			continue;
		expected++;
		if (
			!manifest.workflows?.[`workflows/${file}`]?.[node.name.text]?.workflowId
		)
			missing.push(`${file}:${node.name.text}`);
	}
}
if (!expected || missing.length)
	throw new Error(
		`Workflow manifest is incomplete: ${missing.join(", ") || "no source workflows discovered"}`,
	);
console.log(`Verified ${expected} source workflows in the compiled manifest.`);
