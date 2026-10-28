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
const allowedOptions = new Set([
	"capture",
	"ownerEditPassed",
	"domainPublic",
	"retryAfterZeroUploadFailure",
	"instrumentedThirdStart",
	"normalDeviceFourthStart",
]);

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
	if (options.retryAfterZeroUploadFailure && !options.capture)
		throw Error("production_retry_requires_capture");
	if (
		options.instrumentedThirdStart &&
		(!options.capture || options.retryAfterZeroUploadFailure)
	)
		throw Error("production_third_start_requires_exclusive_capture");
	if (
		options.normalDeviceFourthStart &&
		(!options.capture ||
			options.instrumentedThirdStart ||
			options.retryAfterZeroUploadFailure)
	)
		throw Error("production_fourth_start_requires_exclusive_capture");
}
export function parseProductionArguments(args) {
	const allowed = new Set([
		"--prepare",
		"--go-live",
		"--capture",
		"--owner-edit-passed",
		"--domain-public",
		"--retry-after-zero-upload-failure",
		"--instrumented-third-start",
		"--normal-device-fourth-start",
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
			normalDeviceFourthStart: args.includes("--normal-device-fourth-start"),
			instrumentedThirdStart: args.includes("--instrumented-third-start"),
			retryAfterZeroUploadFailure: args.includes(
				"--retry-after-zero-upload-failure",
			),
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
export function validateZeroUploadRetry(budget, failure, diagnostic) {
	if (
		budget?.attempts !== 1 ||
		!budget.synthetic ||
		!budget.tabOnly ||
		failure?.failure !== "production_extension_failed_at_capture" ||
		failure.forbiddenRequest ||
		diagnostic?.recordingStarted !== false ||
		diagnostic.mediaStreamConsumed !== false ||
		diagnostic.putRequestsObserved !== 0 ||
		diagnostic.state?.liveManifests !== 0 ||
		diagnostic.state?.failedRecordings !== 0 ||
		diagnostic.state?.capturedTabs !== 0 ||
		diagnostic.before?.category !== "extension_action_not_invoked" ||
		diagnostic.after?.permitted !== true
	)
		throw Error("zero_upload_retry_not_verified");
}
async function writeOnceOrMatch(file, bytes) {
	try {
		await writeFile(file, bytes, { flag: "wx" });
	} catch (error) {
		if (
			error?.code !== "EEXIST" ||
			!Buffer.from(await readFile(file)).equals(Buffer.from(bytes))
		)
			throw Error("private_history_preservation_failed");
	}
}
export function recorderErrorEvidence(value) {
	return String(value ?? "")
		.replace(/(?:https?|chrome-extension):\/\/[^\s]+/g, "[url]")
		.replace(/Bearer\s+[^\s]+/gi, "Bearer [redacted]")
		.replace(/[A-Za-z0-9_-]{24,}/g, "[identifier]")
		.replace(/\b\d{6,}\b/g, "[number]")
		.slice(0, 500);
}
export function installStartResponseObserver() {
	const original = chrome.runtime.sendMessage;
	globalThis.__tamRecorderStartReply = null;
	chrome.runtime.sendMessage = function (...args) {
		if (
			args[0]?.type !== "start-recording" ||
			typeof args.at(-1) !== "function"
		)
			return original.apply(this, args);
		const callback = args.at(-1);
		args[args.length - 1] = (response) => {
			globalThis.__tamRecorderStartReply = {
				requestedMode: args[0].mode,
				ok: Boolean(response?.ok),
				error: String(response?.error ?? ""),
				runtimeError: String(chrome.runtime.lastError?.message ?? ""),
				phase: response?.status?.phase ?? null,
			};
			if (typeof globalThis.__tamCaptureStartObservation === "function")
				void globalThis
					.__tamCaptureStartObservation(globalThis.__tamRecorderStartReply)
					.catch(() => undefined);
			return callback(response);
		};
		return original.apply(this, args);
	};
}
async function reserveCaptureBudget(options, liveState) {
	const retry = options.retryAfterZeroUploadFailure;
	if (options.normalDeviceFourthStart) {
		const previous = JSON.parse(
			await readFile(
				path.join(
					productionPaths.privateRoot,
					"capture-attempt-3-instrumented.json",
				),
				"utf8",
			),
		);
		const bytes = await readFile(
			path.join(productionPaths.privateRoot, "failure.json"),
		);
		const failure = JSON.parse(bytes);
		if (
			previous.attempts !== 3 ||
			failure.captureAttempt !== 3 ||
			failure.uploadRequests !== 0 ||
			failure.successfulUploads !== 0 ||
			failure.uploadedBytesObserved !== 0 ||
			failure.offscreen?.message !== "Requested device not found" ||
			liveState.capturedTabs !== 0 ||
			liveState.liveManifests !== 0 ||
			liveState.failedRecordings !== 0
		)
			throw Error("fourth_start_zero_upload_prerequisite_failed");
		await access(
			path.join(productionPaths.privateRoot, "failure-attempt-1.json"),
		);
		await access(
			path.join(productionPaths.privateRoot, "failure-attempt-2.json"),
		);
		await access(
			path.join(productionPaths.privateRoot, "native-auth-result.json"),
		);
		await writeOnceOrMatch(
			path.join(productionPaths.privateRoot, "failure-attempt-3.json"),
			bytes,
		);
		await writeFile(
			path.join(
				productionPaths.privateRoot,
				"capture-attempt-4-native-tab.json",
			),
			JSON.stringify({
				attempts: 4,
				instrumented: true,
				synthetic: true,
				tabOnly: true,
				fakeDeviceFlags: false,
				priorUploadRequests: 0,
				liveState,
				reservedAt: new Date().toISOString(),
			}),
			{ flag: "wx" },
		);
		return;
	}
	if (options.instrumentedThirdStart) {
		const prior = JSON.parse(
			await readFile(
				path.join(productionPaths.privateRoot, "capture-attempt-2.json"),
				"utf8",
			),
		);
		const failureBytes = await readFile(
			path.join(productionPaths.privateRoot, "failure.json"),
		);
		const failure = JSON.parse(failureBytes);
		if (
			prior.attempts !== 2 ||
			failure.captureAttempt !== 2 ||
			failure.uploadRequests !== 0 ||
			failure.successfulUploads !== 0 ||
			failure.uploadedBytesObserved !== 0 ||
			failure.failure !== "production_extension_failed_at_capture" ||
			liveState.capturedTabs !== 0 ||
			liveState.liveManifests !== 0 ||
			liveState.failedRecordings !== 0
		)
			throw Error("third_start_zero_upload_prerequisite_failed");
		await access(
			path.join(productionPaths.privateRoot, "failure-attempt-1.json"),
		);
		await access(
			path.join(productionPaths.privateRoot, "native-auth-result.json"),
		);
		await writeOnceOrMatch(
			path.join(productionPaths.privateRoot, "failure-attempt-2.json"),
			failureBytes,
		);
		await writeFile(
			path.join(
				productionPaths.privateRoot,
				"capture-attempt-3-instrumented.json",
			),
			JSON.stringify({
				attempts: 3,
				instrumented: true,
				synthetic: true,
				tabOnly: true,
				priorUploadRequests: 0,
				reservedAt: new Date().toISOString(),
				liveState,
			}),
			{ flag: "wx" },
		);
		return;
	}
	if (retry) {
		const budget = JSON.parse(
			await readFile(
				path.join(productionPaths.privateRoot, "capture-budget.json"),
				"utf8",
			),
		);
		const previousFailure = await readFile(
			path.join(productionPaths.privateRoot, "failure.json"),
		);
		const diagnostic = JSON.parse(
			await readFile(
				path.join(productionPaths.privateRoot, "tab-permission-diagnosis.json"),
				"utf8",
			),
		);
		validateZeroUploadRetry(budget, JSON.parse(previousFailure), diagnostic);
		await writeOnceOrMatch(
			path.join(productionPaths.privateRoot, "failure-attempt-1.json"),
			previousFailure,
		);
	}
	await writeFile(
		path.join(
			productionPaths.privateRoot,
			retry ? "capture-attempt-2.json" : "capture-budget.json",
		),
		JSON.stringify({
			attempts: retry ? 2 : 1,
			reservedAt: new Date().toISOString(),
			synthetic: true,
			tabOnly: true,
			...(retry
				? { priorFailure: "failure-attempt-1.json", priorUploadRequests: 0 }
				: {}),
		}),
		{ flag: "wx" },
	);
}
export async function invokeProductionToolbar(context, target) {
	const expected = `${productionOrigin}${syntheticPath}`;
	if (target.url() !== expected)
		throw Error("synthetic_action_target_required");
	const protocol = await context.browser().newBrowserCDPSession();
	try {
		const { targetInfos } = await protocol.send("Target.getTargets", {
			filter: [{ type: "tab", exclude: false }, { exclude: true }],
		});
		const matches = targetInfos.filter(
			(info) => info.type === "tab" && info.url === expected,
		);
		if (matches.length !== 1)
			throw Error("synthetic_browser_tab_target_ambiguous");
		await protocol.send("Extensions.triggerAction", {
			id: productionExtensionId,
			targetId: matches[0].targetId,
		});
	} finally {
		await protocol.detach();
	}
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
	let recorderDiagnostic = null;
	let activePanel = null;
	let statusReader = null;
	let observedStartReply = null;
	try {
		await context.setExtraHTTPHeaders({});
		await context.exposeBinding(
			"__tamCaptureStartObservation",
			(source, reply) => {
				if (
					source.frame
						.url()
						.startsWith(
							`chrome-extension://${productionExtensionId}/popup.html`,
						)
				)
					observedStartReply = reply;
			},
		);
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
					"/api/extension/instant-recordings",
					"/api/upload/multipart/initiate",
					"/api/upload/multipart/complete",
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
			await writeOnceOrMatch(
				path.join(productionPaths.privateRoot, "native-auth-result.json"),
				await readFile(path.join(productionPaths.privateRoot, "result.json")),
			);
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
			for (const existing of context.pages())
				if (existing.url() === `${productionOrigin}${syntheticPath}`)
					await existing.close();
			const target = await context.newPage();
			await target.goto(`${productionOrigin}${syntheticPath}`);
			await target.bringToFront();
			await invokeProductionToolbar(context, target);
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
					state["cap-extension-settings"]?.capture?.recordingMode === "tab" &&
					state["cap-extension-settings"]?.webcam?.enabled === false &&
					state["cap-extension-settings"]?.microphone?.enabled === false &&
					state["cap-extension-settings"]?.systemAudio?.enabled === true
				);
			}, `${productionOrigin}${syntheticPath}`);
			if (
				!safeTarget ||
				forbiddenRequest ||
				(await target.title()) !== syntheticTitle
			)
				throw Error("synthetic_tab_isolation_failed");
			await panel
				.getByRole("button", { name: /Start recording/ })
				.waitFor({ state: "visible" });
			if (
				!(await panel.getByRole("combobox").first().innerText()).includes(
					"Current tab",
				)
			)
				throw Error("synthetic_tab_ui_mode_required");
			const liveState = await worker.evaluate(async () => {
				const captured = await chrome.tabCapture.getCapturedTabs();
				const stored = await chrome.storage.local.get([
					"cap-extension-live-recordings",
					"cap-extension-failed-recordings",
				]);
				return {
					capturedTabs: captured.length,
					liveManifests: stored["cap-extension-live-recordings"]?.length ?? 0,
					failedRecordings:
						stored["cap-extension-failed-recordings"]?.length ?? 0,
				};
			});
			await panel.evaluate(installStartResponseObserver);
			activePanel = panel;
			await reserveCaptureBudget(options, liveState);
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
			statusReader = status;
			await poll(async () => {
				const current = await status();
				const reply =
					observedStartReply ??
					(await panel
						.evaluate(() => globalThis.__tamRecorderStartReply)
						.catch(() => null));
				const errors = await panel
					.locator(".text-red-12, .cap-paper-error")
					.allTextContents()
					.catch(() => []);
				recorderDiagnostic = {
					phase: current?.phase ?? null,
					statusMessage: recorderErrorEvidence(current?.message),
					startReply: reply
						? {
								...reply,
								error: recorderErrorEvidence(reply.error),
								runtimeError: recorderErrorEvidence(reply.runtimeError),
							}
						: null,
					popupErrors: errors.map(recorderErrorEvidence),
				};
				if (
					(reply && (!reply.ok || reply.runtimeError)) ||
					errors.some((value) => value.trim()) ||
					current?.phase === "error"
				)
					throw Error("recorder_start_rejected");
				return current?.phase === "recording";
			});
			await new Promise((resolve) =>
				setTimeout(
					resolve,
					options.instrumentedThirdStart || options.normalDeviceFourthStart
						? 5000
						: 3500,
				),
			);
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
			`${JSON.stringify({ ...result, statuses, recorderDiagnostic }, null, "\t")}\n`,
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
		if (activePanel && !observedStartReply) {
			for (let attempt = 0; attempt < 8 && !observedStartReply; attempt++)
				await new Promise((resolve) => setTimeout(resolve, 250));
		}
		const contexts = await worker
			?.evaluate(async () => {
				const entries = await chrome.runtime.getContexts({
					contextTypes: ["OFFSCREEN_DOCUMENT"],
				});
				if (!entries.length) return { count: 0, phase: null, runtimeError: "" };
				return new Promise((resolve) =>
					chrome.runtime.sendMessage(
						{ target: "offscreen", type: "get-recording-status" },
						(response) =>
							resolve({
								count: entries.length,
								phase: response?.status?.phase ?? null,
								message: String(response?.status?.message ?? ""),
								runtimeError: String(chrome.runtime.lastError?.message ?? ""),
							}),
					),
				);
			})
			.catch(() => null);
		if (activePanel) {
			const reply =
				observedStartReply ??
				(await activePanel
					.evaluate(() => globalThis.__tamRecorderStartReply)
					.catch(() => null));
			const errors = await activePanel
				.locator(".text-red-12, .cap-paper-error")
				.allTextContents()
				.catch(() => []);
			const current = await statusReader?.().catch(() => null);
			recorderDiagnostic = {
				phase: current?.phase ?? null,
				statusMessage: recorderErrorEvidence(current?.message),
				startReply: reply
					? {
							...reply,
							error: recorderErrorEvidence(reply.error),
							runtimeError: recorderErrorEvidence(reply.runtimeError),
						}
					: null,
				popupErrors: errors.map(recorderErrorEvidence),
			};
		}
		await writeFile(
			path.join(productionPaths.privateRoot, "failure.json"),
			JSON.stringify({
				failure: safeProductionFailure(step),
				forbiddenRequest,
				uploadRequests,
				successfulUploads,
				uploadedBytesObserved: uploadedBytes,
				captureAttempt: options.normalDeviceFourthStart
					? 4
					: options.instrumentedThirdStart
						? 3
						: options.retryAfterZeroUploadFailure
							? 2
							: 1,
				recorderDiagnostic,
				offscreen: contexts
					? {
							...contexts,
							message: recorderErrorEvidence(contexts.message),
							runtimeError: recorderErrorEvidence(contexts.runtimeError),
						}
					: null,
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
