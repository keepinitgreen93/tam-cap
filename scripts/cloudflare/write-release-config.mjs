import { randomUUID } from "node:crypto";
import {
	lstat,
	mkdir,
	readFile,
	realpath,
	rename,
	rm,
	writeFile,
} from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { isDeepStrictEqual } from "node:util";
import ts from "typescript";

const repository = path.resolve(
	path.dirname(fileURLToPath(import.meta.url)),
	"../..",
);
const account = "c1e96a4b36c73f3cf4ddf50a90082d94";
const namespace = `registry.cloudflare.com/${account}`;
const origins = {
	staging: "https://tam-cap-app.ciglesia.workers.dev",
	production: "https://videos.trulyauthenticmarketing.com",
};
const help =
	"Usage: node scripts/cloudflare/write-release-config.mjs --manifest <image-manifest.json> --target staging|production [--output infra/cloudflare/releases/<name>.json] [--ready] [--maintenance] [--force]";

function record(value, label) {
	if (!value || typeof value !== "object" || Array.isArray(value))
		throw new Error(`Invalid ${label}`);
	return value;
}
function targetOrigin(target) {
	if (!Object.hasOwn(origins, target))
		throw new Error("Invalid release target");
	return origins[target];
}
function image(value, repositoryName) {
	const prefix = `${namespace}/${repositoryName}@sha256:`;
	if (
		typeof value !== "string" ||
		!value.startsWith(prefix) ||
		!/^[0-9a-f]{64}$/.test(value.slice(prefix.length))
	)
		throw new Error(`Invalid immutable ${repositoryName} image`);
	return value;
}
export function validateManifest(value, target) {
	const artifact = record(value, "image manifest");
	const keys = ["mediaImage", "origin", "sourceRevision", "webImage"];
	if (!isDeepStrictEqual(Object.keys(artifact).sort(), keys))
		throw new Error("Unexpected image manifest fields");
	if (artifact.origin !== targetOrigin(target))
		throw new Error("Image manifest origin does not match release target");
	if (
		typeof artifact.sourceRevision !== "string" ||
		!/^[0-9a-f]{40}$/.test(artifact.sourceRevision)
	)
		throw new Error("Invalid full source revision");
	return {
		webImage: image(artifact.webImage, "tam-cap-web"),
		mediaImage: image(artifact.mediaImage, "tam-cap-media"),
		origin: artifact.origin,
		sourceRevision: artifact.sourceRevision,
	};
}
function contained(root, file) {
	const relative = path.relative(root, file);
	if (
		relative.startsWith(`..${path.sep}`) ||
		relative === ".." ||
		path.isAbsolute(relative)
	)
		throw new Error("Release path escapes repository");
	return file;
}
function outputFile(root, value) {
	if (
		typeof value !== "string" ||
		path.win32.isAbsolute(value) ||
		path.posix.isAbsolute(value)
	)
		throw new Error("Release output destination must be repository-relative");
	const normalized = value.replaceAll("\\", "/");
	const parts = normalized.split("/");
	if (
		!normalized.startsWith("infra/cloudflare/releases/") ||
		!normalized.endsWith(".json") ||
		parts.some(
			(part) =>
				!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(part) ||
				part === "." ||
				part === ".." ||
				part.endsWith(".") ||
				/^(?:CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])(?:\.|$)/i.test(part),
		)
	)
		throw new Error("Invalid release output destination");
	return contained(root, path.resolve(root, ...parts));
}
function boolean(value, label) {
	if (typeof value !== "boolean")
		throw new Error(`${label} must be an explicit boolean`);
	return value;
}
export function buildReleaseConfig(template, manifest, options) {
	const artifact = validateManifest(manifest, options.target);
	const root = path.resolve(options.root);
	const output = outputFile(root, options.output);
	const config = structuredClone(record(template, "runtime template"));
	if (config.name !== "tam-cap-app" || config.account_id !== account)
		throw new Error("Runtime template application or account mismatch");
	const directory = path.join(root, "infra/cloudflare");
	const rebase = (value) => {
		if (typeof value !== "string" || !value)
			throw new Error("Invalid runtime template path");
		return path
			.relative(
				path.dirname(output),
				contained(root, path.resolve(directory, value)),
			)
			.split(path.sep)
			.join("/");
	};
	config.main = rebase(config.main);
	if (!Array.isArray(config.d1_databases) || config.d1_databases.length === 0)
		throw new Error("Missing template databases");
	config.d1_databases = config.d1_databases.map((database) => ({
		...database,
		migrations_dir: rebase(database.migrations_dir),
	}));
	if (!Array.isArray(config.containers) || config.containers.length !== 2)
		throw new Error("Unexpected template containers");
	for (const [className, reference] of [
		["CapWeb", artifact.webImage],
		["CapMedia", artifact.mediaImage],
	]) {
		const matches = config.containers.filter(
			(container) => container.class_name === className,
		);
		if (
			matches.length !== 1 ||
			matches[0].scheduling_policy !== "durable_object"
		)
			throw new Error("Native container policy mismatch");
		const container = matches[0];
		container.images = {
			...record(container.images, "container images"),
			base: { image: reference },
		};
	}
	config.vars = {
		...record(config.vars, "runtime variables"),
		CAP_DEPLOYMENT_ID: artifact.sourceRevision,
		CAP_WEB_IMAGE_REVISION: artifact.webImage,
		CAP_RUNTIME_READY: String(
			boolean(options.ready === undefined ? false : options.ready, "ready"),
		),
		CAP_MAINTENANCE_ENABLED: String(
			boolean(
				options.maintenance === undefined ? false : options.maintenance,
				"maintenance",
			),
		),
	};
	config.workers_dev = options.target === "staging";
	config.routes =
		options.target === "production"
			? [{ pattern: "videos.trulyauthenticmarketing.com", custom_domain: true }]
			: [];
	return config;
}
async function boundedFile(file) {
	const buffer = await readFile(file);
	if (buffer.length > 65536) throw new Error("Release input exceeds 64 KiB");
	return buffer.toString("utf8");
}
function json(text, label) {
	try {
		return JSON.parse(text);
	} catch {
		throw new Error(`Invalid ${label} JSON`);
	}
}
async function noLinks(root, file) {
	let current = root;
	for (const part of path.relative(root, file).split(path.sep)) {
		current = path.join(current, part);
		let entry;
		try {
			entry = await lstat(current);
		} catch (error) {
			if (error.code === "ENOENT") continue;
			throw error;
		}
		if (
			entry.isSymbolicLink() ||
			(current === file
				? !entry.isFile() || entry.nlink !== 1
				: !entry.isDirectory())
		)
			throw new Error(
				"Release destination contains a symbolic link or unsupported file",
			);
	}
}
function assertGenerated(config, template, options) {
	try {
		const vars = record(config.vars, "generated variables");
		const oldManifest = {
			webImage: config.containers.find(
				(container) => container.class_name === "CapWeb",
			).images.base.image,
			mediaImage: config.containers.find(
				(container) => container.class_name === "CapMedia",
			).images.base.image,
			origin: targetOrigin(options.target),
			sourceRevision: vars.CAP_DEPLOYMENT_ID,
		};
		if (
			!["true", "false"].includes(vars.CAP_RUNTIME_READY) ||
			!["true", "false"].includes(vars.CAP_MAINTENANCE_ENABLED)
		)
			throw new Error("Invalid flags");
		const expected = buildReleaseConfig(template, oldManifest, {
			...options,
			ready: vars.CAP_RUNTIME_READY === "true",
			maintenance: vars.CAP_MAINTENANCE_ENABLED === "true",
		});
		if (!isDeepStrictEqual(config, expected))
			throw new Error("Configuration differs");
	} catch {
		throw new Error(
			"Refusing to overwrite an unknown or modified generated configuration for this application/account/target",
		);
	}
}
export async function writeReleaseConfig(options, repositoryRoot = repository) {
	const root = await realpath(repositoryRoot);
	const force = boolean(
		options.force === undefined ? false : options.force,
		"force",
	);
	const ready = boolean(
		options.ready === undefined ? false : options.ready,
		"ready",
	);
	const maintenance = boolean(
		options.maintenance === undefined ? false : options.maintenance,
		"maintenance",
	);
	if (typeof options.manifest !== "string" || !options.manifest)
		throw new Error("Image manifest path is required");
	const artifact = validateManifest(
		json(
			await boundedFile(path.resolve(root, options.manifest)),
			"image manifest",
		),
		options.target,
	);
	const output =
		options.output ??
		`infra/cloudflare/releases/${options.target}-${artifact.sourceRevision}.json`;
	const file = outputFile(root, output);
	const templateFile = path.join(
		root,
		"infra/cloudflare/wrangler.runtime.jsonc",
	);
	await noLinks(root, templateFile);
	const parsed = ts.parseConfigFileTextToJson(
		templateFile,
		await boundedFile(templateFile),
	);
	if (parsed.error) throw new Error("Invalid runtime template JSONC");
	const parameters = {
		root,
		output,
		target: options.target,
		ready,
		maintenance,
	};
	const config = buildReleaseConfig(parsed.config, artifact, parameters);
	await noLinks(root, file);
	let previous;
	try {
		previous = await boundedFile(file);
	} catch (error) {
		if (error.code !== "ENOENT") throw error;
	}
	if (previous !== undefined) {
		if (!force)
			throw new Error(
				"Release config already exists; use --force for a validated generated file",
			);
		assertGenerated(
			json(previous, "existing generated configuration"),
			parsed.config,
			parameters,
		);
	}
	await mkdir(path.dirname(file), { recursive: true });
	await noLinks(root, file);
	const serialized = `${JSON.stringify(config, null, "\t")}\n`;
	if (previous === undefined) await writeFile(file, serialized, { flag: "wx" });
	else {
		const temporary = `${file}.${randomUUID()}.tmp`;
		try {
			await writeFile(temporary, serialized, { flag: "wx" });
			await noLinks(root, file);
			if ((await boundedFile(file)) !== previous)
				throw new Error("Release destination changed before replacement");
			await rename(temporary, file);
		} finally {
			await rm(temporary, { force: true });
		}
	}
	return file;
}
export function parseArguments(args) {
	const result = {};
	const values = new Set(["manifest", "target", "output"]);
	const switches = new Set(["ready", "maintenance", "force", "help"]);
	for (let index = 0; index < args.length; index++) {
		const name = args[index].startsWith("--") ? args[index].slice(2) : "";
		if (
			(!values.has(name) && !switches.has(name)) ||
			Object.hasOwn(result, name)
		)
			throw new Error("Unknown or duplicate release argument");
		if (switches.has(name)) result[name] = true;
		else {
			const value = args[++index];
			if (!value || value.startsWith("--"))
				throw new Error("Missing release argument value");
			result[name] = value;
		}
	}
	if (!result.help) {
		if (!result.manifest) throw new Error("--manifest is required");
		targetOrigin(result.target);
	}
	return result;
}
if (
	process.argv[1] &&
	import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href
) {
	try {
		const options = parseArguments(process.argv.slice(2));
		if (options.help) console.log(help);
		else
			console.log(
				`Release config written: ${path
					.relative(repository, await writeReleaseConfig(options))
					.split(path.sep)
					.join("/")}`,
			);
	} catch (error) {
		console.error(
			error instanceof Error ? error.message : "Release configuration failed",
		);
		process.exitCode = 1;
	}
}
