import { spawnSync } from "node:child_process";
import { resolve } from "node:path";

const executable = process.argv[2];
if (!executable) throw new Error("Pass the packaged desktop executable path");
const result = spawnSync(resolve(executable), ["--print-distribution"], {
	encoding: "utf8",
	windowsHide: true,
	timeout: 30_000,
});
if (result.error || result.status !== 0)
	throw new Error(`Packaged desktop probe failed (exit ${result.status})`);
const distribution = JSON.parse(result.stdout.trim());
if (
	distribution.selfHosted !== true ||
	distribution.serverUrl !== "https://videos.trulyauthenticmarketing.com" ||
	distribution.instanceIdentifier !== "com.trulyauthenticmarketing.cap" ||
	distribution.automaticUpdates !== false
)
	throw new Error("Packaged desktop distribution settings do not match TAM");
console.log(
	"Packaged desktop executable loads with the verified TAM configuration.",
);
