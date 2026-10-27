import { access, mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "@playwright/test";

const extensionRoot = path.resolve(
	path.dirname(fileURLToPath(import.meta.url)),
	"..",
);
const repoRoot = path.resolve(extensionRoot, "../..");
export const stagingOrigin = "https://tam-cap-app.ciglesia.workers.dev";
const privateRoot = path.join(repoRoot, ".secrets", "extension-live");
const previewFile = path.join(repoRoot, "tmp", "cap-preview-key.txt");
const ownerStateFile = path.join(repoRoot, ".secrets", "staging-auth.json");
const syntheticPath = "/__tam_extension_synthetic__";
const syntheticDocument =
	'<!doctype html><html><head><title>TAM Extension Live Synthetic Capture</title></head><body style="margin:0;background:#132437;color:white;font:32px system-ui;padding:80px"><h1>Synthetic extension verification</h1><p>This clip contains generated browser visuals and test audio only.</p><p id="clock"></p><script>setInterval(()=>document.querySelector("#clock").textContent=new Date().toISOString(),100)</script></body></html>';

export function previewHeadersForUrl(url, incomingHeaders, previewKey) {
	const headers = new Headers(incomingHeaders);
	headers.delete("x-cap-preview-key");
	if (new URL(url).origin === stagingOrigin)
		headers.set("x-cap-preview-key", previewKey);
	return Object.fromEntries(headers);
}

export function installPrivatePreviewFetch({ origin, previewKey }) {
	const original = globalThis.fetch.bind(globalThis);
	globalThis.fetch = (input, init) => {
		const request = new Request(input, init);
		const headers = new Headers(request.headers);
		headers.delete("x-cap-preview-key");
		const matchesOrigin = new URL(request.url).origin === origin;
		if (matchesOrigin) headers.set("x-cap-preview-key", previewKey);
		return original(
			new Request(request, {
				headers,
				...(matchesOrigin ? { redirect: "manual" } : {}),
			}),
		);
	};
}

export function permittedOwnerCookies(state) {
	return state.cookies.filter(
		(cookie) =>
			cookie.domain.replace(/^\./, "") === new URL(stagingOrigin).hostname,
	);
}

export async function prepareLiveHarness() {
	const receipt = JSON.parse(
		await readFile(path.join(extensionRoot, "dist/staging/BUILD.json"), "utf8"),
	);
	if (receipt.profile !== "staging" || receipt.apiBaseUrl !== stagingOrigin)
		throw new Error("staging_package_required");
	for (const file of [previewFile, ownerStateFile]) await access(file);
	return {
		mode: "prepared_only",
		origin: stagingOrigin,
		extensionId: receipt.extensionId,
		captureBudget: 1,
		privateProfile: privateRoot,
		networkStarted: false,
	};
}

async function poll(check, timeoutMs = 30000) {
	const start = Date.now();
	while (Date.now() - start < timeoutMs) {
		const value = await check();
		if (value) return value;
		await new Promise((resolve) => setTimeout(resolve, 250));
	}
	throw new Error("bounded_wait_expired");
}

export async function runLiveHarness({
	capture = false,
	afterOwnerCapture = false,
} = {}) {
	if (
		[
			"DEBUG",
			"PWDEBUG",
			"PLAYWRIGHT_TRACE_DIR",
			"PW_TEST_TRACE_DIR",
			"CHROME_LOG_FILE",
		].some((name) => process.env[name])
	)
		throw new Error("debug_logging_must_be_disabled");
	if (capture && !afterOwnerCapture)
		throw new Error("owner_capture_prerequisite_not_confirmed");
	const prepared = await prepareLiveHarness();
	if (
		process.platform === "win32" &&
		path.parse(privateRoot).root.toLowerCase() !== "c:\\"
	)
		throw new Error("private_profile_must_remain_on_c_drive");
	const previewKey = (await readFile(previewFile, "utf8")).trim();
	const ownerState = JSON.parse(await readFile(ownerStateFile, "utf8"));
	const cookies = permittedOwnerCookies(ownerState);
	if (!previewKey || !cookies.length)
		throw new Error("private_owner_configuration_missing");
	await mkdir(privateRoot, { recursive: true });
	let step = "launch";
	let uploadedBytes = 0;
	let completed = false;
	const context = await chromium.launchPersistentContext(
		path.join(privateRoot, "profile"),
		{
			channel: "chromium",
			headless: true,
			viewport: { width: 1280, height: 720 },
			args: [
				`--disable-extensions-except=${path.join(extensionRoot, "dist/staging")}`,
				`--load-extension=${path.join(extensionRoot, "dist/staging")}`,
				"--auto-select-desktop-capture-source=TAM Extension Live Synthetic Capture",
				"--auto-select-tab-capture-source-by-title=TAM Extension Live Synthetic Capture",
				"--enable-usermedia-screen-capturing",
				"--autoplay-policy=no-user-gesture-required",
				"--use-fake-device-for-media-stream",
				"--use-fake-ui-for-media-stream",
			],
		},
	);
	try {
		await context.addCookies(cookies);
		await context.route("**/*", async (route) => {
			try {
				const request = route.request();
				const target = new URL(request.url());
				if (
					request.isNavigationRequest() &&
					request.method() === "GET" &&
					target.origin === stagingOrigin &&
					target.pathname === syntheticPath
				) {
					await route.fulfill({
						contentType: "text/html",
						body: syntheticDocument,
					});
					return;
				}
				const headers = previewHeadersForUrl(
					request.url(),
					request.headers(),
					previewKey,
				);
				if (new URL(request.url()).origin === stagingOrigin) {
					const response = await route.fetch({ headers, maxRedirects: 0 });
					await route.fulfill({ response });
				} else {
					await route.continue({ headers });
				}
			} catch {
				await route.abort("failed").catch(() => undefined);
			}
		});
		context.on("request", (request) => {
			if (request.method() !== "PUT") return;
			const hostname = new URL(request.url()).hostname;
			if (hostname.endsWith(".r2.cloudflarestorage.com"))
				uploadedBytes += request.postDataBuffer()?.byteLength ?? 0;
		});
		const install = async (worker) => {
			if (new URL(worker.url()).host === prepared.extensionId)
				await worker.evaluate(installPrivatePreviewFetch, {
					origin: stagingOrigin,
					previewKey,
				});
		};
		context.on("serviceworker", (worker) => {
			void install(worker).catch(() => undefined);
		});
		const worker =
			context
				.serviceWorkers()
				.find((entry) => new URL(entry.url()).host === prepared.extensionId) ??
			(await context.waitForEvent("serviceworker"));
		await install(worker);
		const popup = await context.newPage();
		await popup.goto(`chrome-extension://${prepared.extensionId}/popup.html`);
		step = "authentication";
		const hasCredential = () =>
			worker.evaluate(async (origin) => {
				const state = await chrome.storage.local.get("cap-extension-auth");
				const auth = state["cap-extension-auth"];
				return Boolean(auth?.authApiKey && auth.apiOrigin === origin);
			}, stagingOrigin);
		let signInExecuted = false;
		if (!(await hasCredential())) {
			const authWindow = context.waitForEvent("page", { timeout: 30000 });
			await popup
				.getByRole("button", { name: "Sign in to Cap", exact: true })
				.click();
			const consent = await authWindow;
			await consent.waitForURL((url) => url.origin === stagingOrigin, {
				timeout: 30000,
			});
			await consent
				.getByRole("button", { name: "Allow access", exact: true })
				.waitFor({ state: "visible", timeout: 15000 });
			await consent
				.getByRole("button", { name: "Allow access", exact: true })
				.click();
			await poll(hasCredential);
			signInExecuted = true;
		}
		const ready = await popup.evaluate(
			async () =>
				new Promise((resolve) => {
					chrome.runtime.sendMessage(
						{ target: "service-worker", type: "bootstrap" },
						(response) =>
							resolve(
								Boolean(
									response?.ok &&
										response.bootstrap?.organization?.id &&
										response.auth?.apiOrigin,
								),
							),
					);
				}),
		);
		if (!ready) throw new Error("authenticated_bootstrap_failed");
		const result = {
			origin: stagingOrigin,
			extensionId: prepared.extensionId,
			signInExecuted,
			authenticatedBootstrap: true,
			syntheticCapture: capture,
			uploadedBytesObserved: 0,
		};
		console.log(
			JSON.stringify({ step: "authenticated", captureRequested: capture }),
		);
		if (capture) {
			step = "synthetic_target";
			await worker.evaluate(
				(origin) =>
					chrome.storage.local.set({
						"cap-extension-settings": {
							apiBaseUrl: origin,
							capture: {
								recordingMode: "fullscreen",
								camera: null,
								microphone: null,
							},
							webcam: {
								enabled: false,
								deviceId: null,
								position: "bottom-left",
								size: 230,
								shape: "round",
								mirror: false,
							},
							microphone: { enabled: true, deviceId: "default" },
							systemAudio: { enabled: false },
							sounds: { enabled: false },
							countdown: { enabled: false, seconds: 3 },
							microphoneWarning: { enabled: false },
						},
					}),
				stagingOrigin,
			);
			const target = await context.newPage();
			await target.goto(`${stagingOrigin}${syntheticPath}`);
			await target.bringToFront();
			await popup.evaluate(
				async () =>
					new Promise((resolve) =>
						chrome.runtime.sendMessage(
							{ target: "service-worker", type: "open-recorder-panel" },
							() => resolve(true),
						),
					),
			);
			const panel = await poll(() =>
				Promise.resolve(
					target
						.frames()
						.find((frame) =>
							frame.url().includes(`${prepared.extensionId}/popup.html`),
						),
				),
			);
			await panel
				.getByRole("button", { name: /Start recording/ })
				.waitFor({ state: "visible" });
			await writeFile(
				path.join(privateRoot, "capture-budget.json"),
				JSON.stringify({
					attempts: 1,
					reservedAt: new Date().toISOString(),
					synthetic: true,
				}),
				{ flag: "wx" },
			);
			step = "capture";
			await panel.getByRole("button", { name: /Start recording/ }).click();
			const status = () =>
				popup.evaluate(
					async () =>
						new Promise((resolve) =>
							chrome.runtime.sendMessage(
								{ target: "service-worker", type: "get-recording-status" },
								(response) => resolve(response?.ok ? response.status : null),
							),
						),
				);
			await poll(async () => (await status())?.phase === "recording");
			await new Promise((resolve) => setTimeout(resolve, 3500));
			step = "stop_and_upload";
			const stopped = await popup.evaluate(
				async () =>
					new Promise((resolve) =>
						chrome.runtime.sendMessage(
							{ target: "service-worker", type: "stop-recording" },
							(response) => resolve(Boolean(response?.ok)),
						),
					),
			);
			if (!stopped) throw new Error("stop_failed");
			const recording = await poll(async () => {
				const current = await status();
				if (current?.phase === "error")
					throw new Error("recording_upload_failed");
				return current?.phase === "completed" ? current : false;
			}, 120000);
			if (new URL(recording.shareUrl).origin !== stagingOrigin)
				throw new Error("share_origin_mismatch");
			step = "share_playback";
			const share = await context.newPage();
			await share.goto(recording.shareUrl);
			await share
				.locator("video")
				.first()
				.waitFor({ state: "attached", timeout: 90000 });
			const playback = await poll(
				() =>
					share
						.locator("video")
						.first()
						.evaluate((video) =>
							video.readyState >= 1 &&
							Number.isFinite(video.duration) &&
							video.duration > 0
								? { duration: video.duration }
								: null,
						),
				90000,
			);
			Object.assign(result, {
				videoId: recording.videoId,
				shareUrl: recording.shareUrl,
				playbackDuration: playback.duration,
				uploadedBytesObserved: uploadedBytes,
			});
		}
		await writeFile(
			path.join(privateRoot, "result.json"),
			`${JSON.stringify(result, null, "\t")}\n`,
		);
		completed = true;
		console.log(
			JSON.stringify({
				step: "complete",
				authenticated: true,
				recorded: capture,
				resultStoredPrivately: true,
			}),
		);
		return result;
	} catch {
		await writeFile(
			path.join(privateRoot, "failure.json"),
			JSON.stringify({
				step,
				completed: false,
				timestamp: new Date().toISOString(),
			}),
		);
		throw new Error(`live_extension_failed_at_${step}`);
	} finally {
		await context.close();
		if (!completed)
			console.log(
				JSON.stringify({ step, completed: false, detailsKeptPrivate: true }),
			);
	}
}

if (
	process.argv[1] &&
	path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
	const argumentsSet = new Set(process.argv.slice(2));
	try {
		if (!argumentsSet.has("--go-live"))
			console.log(JSON.stringify(await prepareLiveHarness()));
		else
			await runLiveHarness({
				capture: argumentsSet.has("--capture"),
				afterOwnerCapture: argumentsSet.has("--after-owner-capture"),
			});
	} catch (error) {
		console.error(
			error instanceof Error &&
				/^live_extension_failed_at_|^owner_capture_prerequisite_not_confirmed$/.test(
					error.message,
				)
				? error.message
				: "live_extension_harness_preflight_failed",
		);
		process.exitCode = 1;
	}
}
