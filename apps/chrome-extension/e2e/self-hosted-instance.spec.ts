import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { chromium, expect, test } from "@playwright/test";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const extensionPath =
	process.env.CAP_EXTENSION_DIST ?? path.join(root, "dist/production");

test("loads the pinned self-hosted package and clears credentials when the instance changes", async () => {
	const manifest = JSON.parse(
		await readFile(path.join(extensionPath, "manifest.json"), "utf8"),
	);
	const receipt = JSON.parse(
		await readFile(path.join(extensionPath, "BUILD.json"), "utf8"),
	);
	const directory = await mkdtemp(
		path.join(tmpdir(), "tam-cap-extension-profile-"),
	);
	if (
		path.dirname(directory) !== path.resolve(tmpdir()) ||
		!path.basename(directory).startsWith("tam-cap-extension-profile-")
	)
		throw new Error("Unexpected test profile path");
	const context = await chromium.launchPersistentContext(directory, {
		channel: "chromium",
		headless: true,
		args: [
			`--disable-extensions-except=${extensionPath}`,
			`--load-extension=${extensionPath}`,
		],
	});
	try {
		const worker =
			context.serviceWorkers()[0] ??
			(await context.waitForEvent("serviceworker"));
		expect(new URL(worker.url()).hostname).toBe(receipt.extensionId);
		await worker.evaluate(
			(origin: string) =>
				chrome.storage.local.set({
					"cap-extension-auth": {
						authApiKey: "synthetic-origin-test-key",
						userId: "synthetic-user",
						apiOrigin: origin,
					},
				}),
			receipt.apiBaseUrl,
		);
		const page = await context.newPage();
		await page.goto(`chrome-extension://${receipt.extensionId}/options.html`);
		expect(manifest.name).toContain("TAM Cap");
		await expect(page.getByLabel("Cap URL")).toHaveValue(receipt.apiBaseUrl);
		await expect(
			page.getByRole("link", { name: "Dashboard", exact: true }),
		).toHaveAttribute("href", `${receipt.apiBaseUrl}/dashboard`);
		await expect(
			page.getByRole("button", { name: "Sign out", exact: true }),
		).toBeEnabled();
		await page.getByLabel("Cap URL").fill("https://other-instance.example.com");
		await page
			.getByRole("button", { name: "Save changes", exact: true })
			.click();
		await expect(
			page.getByRole("button", { name: "Sign out", exact: true }),
		).toBeDisabled();
		const cleared = await worker.evaluate(async () => {
			const saved = await chrome.storage.local.get("cap-extension-auth");
			return saved["cap-extension-auth"] === undefined;
		});
		expect(cleared).toBe(true);
	} finally {
		await context.close();
		await rm(directory, { recursive: true, force: true });
	}
});
