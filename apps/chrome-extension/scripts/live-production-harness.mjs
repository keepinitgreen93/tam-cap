import { createHash } from "node:crypto";
import { access, mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "@playwright/test";

const extensionRoot = path.resolve(
	path.dirname(fileURLToPath(import.meta.url)),
	"..",
);
const repoRoot = path.resolve(extensionRoot, "../..");
export const productionOrigin = "https://videos.trulyauthenticmarketing.com";
export const productionExtensionId = "ffocnmodhfclminiaapbfapkehcppkga";
export const productionPaths = {
	package: path.join(extensionRoot, "dist/production"),
	privateRoot: path.join(repoRoot, ".secrets/extension-production-live"),
	ownerState: path.join(repoRoot, ".secrets/production-auth.json"),
};
const syntheticPath = "/__tam_extension_production_synthetic__";
const syntheticTitle = "TAM Production Extension Synthetic Tab";
const syntheticDocument = `<!doctype html><html><head><title>${syntheticTitle}</title></head><body style="margin:0;background:#132437;color:white;font:32px system-ui;padding:60px"><h1>Synthetic extension verification</h1><p>Generated browser visuals and test tone only.</p><canvas id="clock" width="900" height="160"></canvas><script>const c=document.querySelector("canvas").getContext("2d");setInterval(()=>{c.clearRect(0,0,900,160);c.fillStyle="white";c.font="32px system-ui";c.fillText(new Date().toISOString(),10,70)},100);const audio=new AudioContext();const tone=audio.createOscillator();const gain=audio.createGain();gain.gain.value=.02;tone.frequency.value=440;tone.connect(gain).connect(audio.destination);tone.start();audio.resume();</script></body></html>`;
const safeSteps = new Set([
	"preflight",
	"launch",
	"identity_start",
	"identity_consent",
	"identity_approval",
	"bootstrap",
	"synthetic_target",
	"synthetic_panel",
	"capture",
	"upload",
	"share",
]);
const allowedOptions = new Set(["capture", "ownerEditPassed", "domainPublic"]);

export function validateProductionOptions(options) {
	if (
		!options ||
		typeof options !== "object" ||
		Object.keys(options).some((key) => !allowedOptions.has(key)) ||
		Object.values(options).some((value) => typeof value !== "boolean")
	)
		throw Error("forbidden_production_option");
	if (!options.ownerEditPassed || !options.domainPublic)
		throw Error("production_release_prerequisites_required");
}
export function parseProductionArguments(args) {
	const allowed = new Set([
		"--prepare",
		"--go-live",
		"--capture",
		"--owner-edit-passed",
		"--domain-public",
	]);
	if (
		args.some((value) => !allowed.has(value)) ||
		new Set(args).size !== args.length ||
		(args.includes("--prepare") && args.includes("--go-live"))
	)
		throw Error("forbidden_production_argument");
	if (args.includes("--capture") && !args.includes("--go-live"))
		throw Error("production_capture_requires_go_live");
	return {
		goLive: args.includes("--go-live"),
		options: {
			capture: args.includes("--capture"),
			ownerEditPassed: args.includes("--owner-edit-passed"),
			domainPublic: args.includes("--domain-public"),
		},
	};
}
export function permittedProductionOwnerCookies(state) {
	return Array.isArray(state?.cookies)
		? state.cookies.filter(
				(cookie) =>
					typeof cookie?.domain === "string" &&
					cookie.domain.replace(/^\./, "") ===
						new URL(productionOrigin).hostname,
			)
		: [];
}
export function productionRequestPolicy(url, headers = {}) {
	if (
		Object.keys(headers).some(
			(key) => key.toLowerCase() === "x-cap-preview-key",
		)
	)
		return "forbidden_header";
	const target = new URL(url);
	if (
		target.hostname === "tam-cap-app.ciglesia.workers.dev" ||
		target.hostname === "cap.so" ||
		target.hostname.endsWith(".cap.so")
	)
		return "forbidden_instance";
	return target.origin === productionOrigin && target.pathname === syntheticPath
		? "synthetic_document"
		: "native_network";
}
export function safeProductionFailure(step) {
	return `production_extension_failed_at_${safeSteps.has(step) ? step : "unknown"}`;
}
export function validateProductionPackage(receipt, manifest, manifestBytes) {
	const id = createHash("sha256")
		.update(Buffer.from(manifest.key ?? "", "base64"))
		.digest("hex")
		.slice(0, 32)
		.replace(/[0-9a-f]/g, (value) =>
			String.fromCharCode(97 + Number.parseInt(value, 16)),
		);
	if (
		receipt.profile !== "production" ||
		receipt.apiBaseUrl !== productionOrigin ||
		receipt.extensionId !== productionExtensionId ||
		manifest.homepage_url !== productionOrigin ||
		id !== productionExtensionId ||
		createHash("sha256").update(manifestBytes).digest("hex") !==
			receipt.manifestSha256
	)
		throw Error("production_package_identity_mismatch");
}
export async function prepareProductionHarness() {
	const receipt = JSON.parse(
		await readFile(path.join(productionPaths.package, "BUILD.json"), "utf8"),
	);
	const manifestBytes = await readFile(
		path.join(productionPaths.package, "manifest.json"),
	);
	validateProductionPackage(
		receipt,
		JSON.parse(manifestBytes.toString("utf8")),
		manifestBytes,
	);
	let ownerStateAvailable = false;
	try {
		await access(productionPaths.ownerState);
		ownerStateAvailable = true;
	} catch {}
	return {
		mode: "prepared_only",
		origin: productionOrigin,
		extensionId: productionExtensionId,
		packageProfile: "production",
		privateProfile: productionPaths.privateRoot,
		ownerStateAvailable,
		networkStarted: false,
		captureBudget: 1,
		identityRequirement: "native_chrome_identity",
		prerequisites: [
			"root_go_live",
			"owner_editor_pass",
			"public_production_domain",
			"production_owner_cookie_state",
		],
	};
}
async function poll(check, timeoutMs = 30000) {
	const start = Date.now();
	while (Date.now() - start < timeoutMs) {
		const result = await check();
		if (result) return result;
		await new Promise((resolve) => setTimeout(resolve, 250));
	}
	throw Error("bounded_wait_expired");
}
async function reserveCaptureBudget() {
	await writeFile(
		path.join(productionPaths.privateRoot, "capture-budget.json"),
		JSON.stringify({
			attempts: 1,
			reservedAt: new Date().toISOString(),
			synthetic: true,
			tabOnly: true,
		}),
		{ flag: "wx" },
	);
}

export async function runProductionHarness(options = {}) {
	validateProductionOptions(options);
	if (
		[
			"DEBUG",
			"PWDEBUG",
			"PLAYWRIGHT_TRACE_DIR",
			"PW_TEST_TRACE_DIR",
			"CHROME_LOG_FILE",
		].some((name) => process.env[name])
	)
		throw Error("production_debug_logging_forbidden");
	await prepareProductionHarness();
	if (
		process.platform === "win32" &&
		path.parse(productionPaths.privateRoot).root.toLowerCase() !== "c:\\"
	)
		throw Error("production_profile_requires_private_c_drive");
	const ownerState = JSON.parse(
		await readFile(productionPaths.ownerState, "utf8"),
	);
	const cookies = permittedProductionOwnerCookies(ownerState);
	if (!cookies.length) throw Error("production_owner_state_unavailable");
	await mkdir(productionPaths.privateRoot, { recursive: true });
	const context = await chromium.launchPersistentContext(
		path.join(productionPaths.privateRoot, "profile"),
		{
			channel: "chromium",
			headless: false,
			viewport: { width: 1280, height: 720 },
			args: [
				`--disable-extensions-except=${productionPaths.package}`,
				`--load-extension=${productionPaths.package}`,
				`--auto-select-tab-capture-source-by-title=${syntheticTitle}`,
				"--autoplay-policy=no-user-gesture-required",
				"--use-fake-device-for-media-stream",
				"--use-fake-ui-for-media-stream",
				"--disable-background-networking",
			],
		},
	);
	let step = "launch";
	let worker;
	let completed = false;
	let forbiddenRequest = false;
	let uploadedBytes = 0;
	let uploadRequests = 0;
	let successfulUploads = 0;
	const statuses = [];
	try {
		await context.setExtraHTTPHeaders({});
		await context.addCookies(cookies);
		await context.route("**/*", async (route) => {
			const request = route.request();
			const policy = productionRequestPolicy(request.url(), request.headers());
			if (policy.startsWith("forbidden")) {
				forbiddenRequest = true;
				await route.abort();
				return;
			}
			if (
				policy === "synthetic_document" &&
				request.isNavigationRequest() &&
				request.method() === "GET"
			) {
				await route.fulfill({
					contentType: "text/html",
					body: syntheticDocument,
				});
				return;
			}
			await route.continue();
		});
		context.on("request", (request) => {
			if (
				request.method() === "PUT" &&
				new URL(request.url()).hostname.endsWith(".r2.cloudflarestorage.com")
			) {
				uploadRequests++;
				uploadedBytes += request.postDataBuffer()?.byteLength ?? 0;
			}
		});
		context.on("response", (response) => {
			const request = response.request();
			const url = new URL(response.url());
			if (
				request.method() === "PUT" &&
				url.hostname.endsWith(".r2.cloudflarestorage.com") &&
				response.ok()
			)
				successfulUploads++;
			if (
				url.origin === productionOrigin &&
				[
					"/api/extension/auth/start",
					"/api/extension/auth/approve",
					"/api/extension/bootstrap",
				].includes(url.pathname)
			)
				statuses.push({ endpoint: url.pathname, status: response.status() });
		});
		worker =
			context
				.serviceWorkers()
				.find((value) => new URL(value.url()).host === productionExtensionId) ??
			(await context.waitForEvent("serviceworker", {
				predicate: (value) =>
					new URL(value.url()).host === productionExtensionId,
				timeout: 30000,
			}));
		const popup = await context.newPage();
		await popup.goto(`chrome-extension://${productionExtensionId}/popup.html`);
		const hasCredential = () =>
			worker.evaluate(async (origin) => {
				const state = await chrome.storage.local.get("cap-extension-auth");
				const auth = state["cap-extension-auth"];
				return Boolean(auth?.authApiKey && auth.apiOrigin === origin);
			}, productionOrigin);
		let signInExecuted = false;
		if (await hasCredential()) {
			const prior = JSON.parse(
				await readFile(
					path.join(productionPaths.privateRoot, "result.json"),
					"utf8",
				),
			);
			if (
				!options.capture ||
				prior.identityFlow !== "native_chrome_identity" ||
				!prior.signInExecuted ||
				!prior.authenticatedBootstrap ||
				prior.origin !== productionOrigin ||
				prior.extensionId !== productionExtensionId
			)
				throw Error("fresh_native_auth_required");
		} else {
			step = "identity_start";
			const existingPages = new Set(context.pages());
			await popup
				.getByRole("button", { name: "Sign in to Cap", exact: true })
				.click();
			const consent = await poll(
				() =>
					Promise.resolve(
						context
							.pages()
							.find(
								(page) =>
									!existingPages.has(page) &&
									new URL(page.url()).origin === productionOrigin,
							),
					),
				45000,
			);
			step = "identity_consent";
			await consent.waitForURL((url) => url.origin === productionOrigin, {
				timeout: 30000,
			});
			await consent
				.getByRole("button", { name: "Allow access", exact: true })
				.waitFor({ state: "visible", timeout: 20000 });
			step = "identity_approval";
			await consent
				.getByRole("button", { name: "Allow access", exact: true })
				.click();
			await poll(hasCredential);
			signInExecuted = true;
		}
		step = "bootstrap";
		const ready = await popup.evaluate(
			async (origin) =>
				new Promise((resolve) => {
					chrome.runtime.sendMessage(
						{ target: "service-worker", type: "bootstrap" },
						(response) =>
							resolve(
								Boolean(
									response?.ok &&
										response.bootstrap?.organization?.id &&
										response.auth?.apiOrigin === origin,
								),
							),
					);
				}),
			productionOrigin,
		);
		if (!ready || forbiddenRequest) throw Error("production_bootstrap_failed");
		const result = {
			origin: productionOrigin,
			extensionId: productionExtensionId,
			identityFlow: signInExecuted
				? "native_chrome_identity"
				: "previously_verified_native_chrome_identity",
			signInExecuted,
			authenticatedBootstrap: true,
			captureRequested: Boolean(options.capture),
			syntheticTabOnly: false,
			uploadRequests: 0,
			successfulUploads: 0,
			uploadedBytesObserved: 0,
		};
		if (options.capture) {
			step = "synthetic_target";
			await worker.evaluate(
				(origin) =>
					chrome.storage.local.set({
						"cap-extension-settings": {
							apiBaseUrl: origin,
							capture: { recordingMode: "tab", camera: null, microphone: null },
							webcam: {
								enabled: false,
								deviceId: null,
								position: "bottom-left",
								size: 230,
								shape: "round",
								mirror: false,
							},
							microphone: { enabled: false, deviceId: null },
							systemAudio: { enabled: true },
							sounds: { enabled: false },
							countdown: { enabled: false, seconds: 3 },
							microphoneWarning: { enabled: false },
						},
					}),
				productionOrigin,
			);
			const target = await context.newPage();
			await target.goto(`${productionOrigin}${syntheticPath}`);
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
			step = "synthetic_panel";
			const panel = await poll(() =>
				Promise.resolve(
					target
						.frames()
						.find((frame) =>
							frame.url().includes(`${productionExtensionId}/popup.html`),
						),
				),
			);
			const safeTarget = await worker.evaluate(async (expected) => {
				const tabs = await chrome.tabs.query({
					active: true,
					lastFocusedWindow: true,
				});
				const state = await chrome.storage.local.get("cap-extension-settings");
				return (
					tabs.length === 1 &&
					tabs[0].url === expected &&
					state["cap-extension-settings"]?.capture?.recordingMode === "tab"
				);
			}, `${productionOrigin}${syntheticPath}`);
			if (!safeTarget || forbiddenRequest)
				throw Error("synthetic_tab_isolation_failed");
			await panel
				.getByRole("button", { name: /Start recording/ })
				.waitFor({ state: "visible" });
			await reserveCaptureBudget();
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
			step = "upload";
			const stopped = await popup.evaluate(
				async () =>
					new Promise((resolve) =>
						chrome.runtime.sendMessage(
							{ target: "service-worker", type: "stop-recording" },
							(response) => resolve(Boolean(response?.ok)),
						),
					),
			);
			if (!stopped) throw Error("production_stop_failed");
			const recording = await poll(async () => {
				const current = await status();
				if (current?.phase === "error") throw Error("production_upload_failed");
				return current?.phase === "completed" ? current : false;
			}, 120000);
			const destination = new URL(recording.shareUrl);
			if (
				destination.origin !== productionOrigin ||
				!/^\/s\/[a-z0-9]{15}$/.test(destination.pathname) ||
				destination.search ||
				destination.hash ||
				!uploadRequests ||
				!successfulUploads ||
				forbiddenRequest
			)
				throw Error("production_share_contract_failed");
			step = "share";
			const share = await context.newPage();
			await share.goto(destination.href);
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
								? {
										duration: video.duration,
										width: video.videoWidth,
										height: video.videoHeight,
										error: video.error?.code ?? null,
									}
								: null,
						),
				90000,
			);
			if (playback.error) throw Error("production_playback_failed");
			Object.assign(result, {
				syntheticTabOnly: true,
				videoId: recording.videoId,
				shareUrl: destination.href,
				playback,
				uploadRequests,
				successfulUploads,
				uploadedBytesObserved: uploadedBytes,
			});
		}
		await writeFile(
			path.join(productionPaths.privateRoot, "result.json"),
			`${JSON.stringify({ ...result, statuses }, null, "\t")}\n`,
		);
		completed = true;
		console.log(
			JSON.stringify({
				completed: true,
				authenticatedBootstrap: true,
				nativeSignInExecuted: signInExecuted,
				syntheticCapture: Boolean(options.capture),
				resultStoredPrivately: true,
			}),
		);
		return result;
	} catch {
		await writeFile(
			path.join(productionPaths.privateRoot, "failure.json"),
			JSON.stringify({
				failure: safeProductionFailure(step),
				forbiddenRequest,
				statuses,
				completed: false,
				timestamp: new Date().toISOString(),
			}),
		);
		throw Error(safeProductionFailure(step));
	} finally {
		await context.close();
		if (!completed)
			console.log(
				JSON.stringify({ completed: false, detailsKeptPrivate: true }),
			);
	}
}

if (
	process.argv[1] &&
	path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
	try {
		const parsed = parseProductionArguments(process.argv.slice(2));
		if (!parsed.goLive)
			console.log(JSON.stringify(await prepareProductionHarness(), null, 2));
		else await runProductionHarness(parsed.options);
	} catch (error) {
		const message =
			error instanceof Error &&
			/^production_extension_failed_at_[a-z_]+$/.test(error.message)
				? error.message
				: "production_extension_preflight_failed";
		console.error(message);
		process.exitCode = 1;
	}
}
