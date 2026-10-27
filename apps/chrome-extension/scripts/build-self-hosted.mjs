import { createHash } from "node:crypto";
import { copyFile, mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "vite";

const extensionRoot = path.resolve(
	path.dirname(fileURLToPath(import.meta.url)),
	"..",
);
const repoRoot = path.resolve(extensionRoot, "../..");

export function extensionIdForKey(key) {
	const bytes = createHash("sha256")
		.update(Buffer.from(key, "base64"))
		.digest()
		.subarray(0, 16);
	return Array.from(bytes)
		.flatMap((value) => [value >> 4, value & 15])
		.map((value) => String.fromCharCode(97 + value))
		.join("");
}

export async function buildSelfHosted(profile = "production") {
	process.chdir(extensionRoot);
	if (profile !== "production" && profile !== "staging")
		throw new Error("Choose production or staging");
	const profiles = JSON.parse(
		await readFile(path.join(extensionRoot, "self-hosted.json"), "utf8"),
	);
	const configuration = profiles[profile];
	const target = new URL(configuration.apiBaseUrl);
	if (target.protocol !== "https:" || target.href !== `${target.origin}/`)
		throw new Error("Build target must be an HTTPS origin");
	const extensionId = extensionIdForKey(configuration.key);
	if (extensionId !== configuration.extensionId)
		throw new Error("Manifest key does not match the pinned extension ID");
	const outDir = path.join(extensionRoot, "dist", profile);
	if (path.dirname(outDir) !== path.join(extensionRoot, "dist"))
		throw new Error("Invalid build output path");
	process.env.VITE_CAP_API_BASE_URL = target.origin;
	for (const [index, config] of [
		"vite.config.ts",
		"vite.content.config.ts",
		"vite.content-overlay.config.ts",
	].entries()) {
		await build({
			root: extensionRoot,
			configFile: path.join(extensionRoot, config),
			mode: "production",
			build: { outDir, emptyOutDir: index === 0 },
		});
	}
	const manifestPath = path.join(outDir, "manifest.json");
	const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
	Object.assign(manifest, {
		name: configuration.name,
		short_name: profile === "staging" ? "TAM Cap Staging" : "TAM Cap",
		homepage_url: target.origin,
		key: configuration.key,
	});
	await writeFile(manifestPath, `${JSON.stringify(manifest, null, "\t")}\n`);
	await mkdir(path.join(outDir, "licenses"), { recursive: true });
	await copyFile(
		path.join(repoRoot, "LICENSE"),
		path.join(outDir, "licenses", "CAP-LICENSE.txt"),
	);
	await copyFile(
		path.join(repoRoot, "licenses", "LICENSE-MIT"),
		path.join(outDir, "licenses", "LICENSE-MIT.txt"),
	);
	const receipt = {
		profile,
		apiBaseUrl: target.origin,
		extensionId,
		version: manifest.version,
		manifestSha256: createHash("sha256")
			.update(await readFile(manifestPath))
			.digest("hex"),
	};
	await writeFile(
		path.join(outDir, "BUILD.json"),
		`${JSON.stringify(receipt, null, "\t")}\n`,
	);
	await writeFile(
		path.join(outDir, "INSTALL.txt"),
		`TAM Cap Chrome extension (${profile})\n\nInstance: ${target.origin}\nExtension ID: ${extensionId}\n\n1. Extract the ZIP to a permanent folder.\n2. Open chrome://extensions and enable Developer mode.\n3. Choose Load unpacked and select the extracted folder containing manifest.json.\n4. Pin TAM Cap, open its recorder and choose Sign in. Use your invited workspace account, then approve extension access.\n5. Options shows the configured instance URL. Changing the URL requires signing in again; credentials are never sent to another instance.\n\nThis is a source-built, unpacked extension. It is not a Chrome Web Store publication and does not automatically update. Replace this folder with a new package and use Reload on chrome://extensions when your administrator provides an update.\nDo not copy authentication keys into chat or email. Local recording recovery remains available in Options after an interrupted upload.\n\nSource and license: https://github.com/keepinitgreen93/tam-cap\n`,
	);
	console.log(JSON.stringify({ ...receipt, outDir }));
	return receipt;
}

if (
	process.argv[1] &&
	path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
	await buildSelfHosted(process.argv[2]);
}
