// @vitest-environment jsdom

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
	act,
	type ComponentProps,
	createElement,
	createRef,
	useEffect,
} from "react";
import { hydrateRoot } from "react-dom/client";
import { renderToString } from "react-dom/server";
import {
	afterAll,
	afterEach,
	beforeAll,
	describe,
	expect,
	it,
	vi,
} from "vitest";
import { retryVideoProcessing } from "@/actions/video/retry-processing";
import { CapVideoPlayer } from "@/app/s/[videoId]/_components/CapVideoPlayer";
import type { UploadProgress } from "@/app/s/[videoId]/_components/upload-progress";
import { getStalledProcessingMessage } from "@/app/s/[videoId]/_components/upload-progress";

vi.mock("@cap/ui", async (importOriginal) => ({
	...(await importOriginal<typeof import("@cap/ui")>()),
	LogoSpinner: () => null,
}));

const uploadState = vi.hoisted(() => ({
	progress: null as UploadProgress | null,
	notify: undefined as ((progress: UploadProgress | null) => void) | undefined,
}));
vi.mock("next/dynamic", () => ({
	default: () =>
		function Tracker({
			onChange,
		}: {
			onChange: (progress: UploadProgress | null) => void;
		}) {
			useEffect(() => {
				uploadState.notify = onChange;
				queueMicrotask(() => onChange(uploadState.progress));
				return () => {
					if (uploadState.notify === onChange) uploadState.notify = undefined;
				};
			}, [onChange]);
			return null;
		},
}));
vi.mock("@/actions/video/retry-processing", () => ({
	retryVideoProcessing: vi.fn(),
}));
vi.mock("@/app/s/[videoId]/_components/CommentStamp", () => ({
	default: () => null,
}));
vi.mock("@/app/s/[videoId]/_components/VideoPreviewGif", () => ({
	VideoPreviewGif: () => null,
}));
vi.mock("@/app/s/[videoId]/_components/caption-tracks", () => ({
	bindCaptionTrackCueText: () => () => undefined,
}));
vi.mock("@/app/s/[videoId]/_components/mp4-level-patch", () => ({
	AVC_LEVEL_IOS_HARDWARE_CEILING: 42,
	createLevelPatchedMp4ObjectUrl: vi.fn(),
	isIosSafari: () => false,
	probeAvcLevelFromUrl: vi.fn(),
}));
vi.mock("@/app/s/[videoId]/_components/video-frame-thumbnail", () => ({
	captureVideoFrameDataUrl: () => undefined,
}));

const actEnvironment = globalThis as typeof globalThis & {
	IS_REACT_ACT_ENVIRONMENT?: boolean;
};

function response(url: string, status: number, redirected = false): Response {
	const result = new Response(null, { status });
	Object.defineProperties(result, {
		url: { value: url },
		redirected: { value: redirected },
	});
	return result;
}

function waitForQueryNotification() {
	return new Promise<void>((resolve) => setTimeout(resolve, 0));
}

async function settleFetch(
	fetchImpl: ReturnType<typeof vi.fn<typeof fetch>>,
	count: number,
) {
	await act(async () => {
		await vi.waitFor(() => expect(fetchImpl).toHaveBeenCalledTimes(count));
		await waitForQueryNotification();
	});
}

const SERVER_URL = "https://v.cap.so/owner/video/result.mp4?Signature=fixture";
const PLAYLIST_PROBE = /^\/api\/playlist\?videoType=mp4&_t=\d+$/;

function playerProps(
	overrides: Partial<ComponentProps<typeof CapVideoPlayer>> = {},
) {
	const videoRef = createRef<HTMLVideoElement>();
	const props: ComponentProps<typeof CapVideoPlayer> = {
		videoSrc: "/api/playlist?videoType=mp4",
		initialPlaybackUrl: Promise.resolve(SERVER_URL),
		serverPlaybackUrl: SERVER_URL,
		enableCrossOrigin: true,
		videoId: "fixture-video" as ComponentProps<
			typeof CapVideoPlayer
		>["videoId"],
		chaptersSrc: "",
		captionsSrc: "",
		videoRef,
		hasActiveUpload: false,
		disablePreviewGif: true,
		...overrides,
	};
	return { props, videoRef };
}

function tree(
	client: QueryClient,
	props: ComponentProps<typeof CapVideoPlayer>,
) {
	return createElement(
		QueryClientProvider,
		{ client },
		createElement(CapVideoPlayer, props),
	);
}

function newClient() {
	return new QueryClient({ defaultOptions: { queries: { retry: false } } });
}

// Server-renders the player, then lets the test change the parsed <video>
// before hydrating, the way the browser loads media while JS is downloading.
async function hydratePlayer(
	props: ComponentProps<typeof CapVideoPlayer>,
	beforeHydrate: (video: HTMLVideoElement) => void = () => undefined,
) {
	const html = renderToString(tree(newClient(), props));
	const container = document.createElement("div");
	container.innerHTML = html;
	document.body.append(container);
	const serverVideo = container.querySelector("video");
	if (serverVideo) beforeHydrate(serverVideo);
	const recoverableErrors: unknown[] = [];
	const client = newClient();
	let root: ReturnType<typeof hydrateRoot> | undefined;
	await act(async () => {
		root = hydrateRoot(container, tree(client, props), {
			onRecoverableError: (error) => recoverableErrors.push(error),
		});
	});
	// Let the scheduled replay run.
	await act(async () => {
		await new Promise((resolve) => setTimeout(resolve, 0));
	});
	return { html, container, serverVideo, client, recoverableErrors, root };
}

function setMediaState(
	video: HTMLVideoElement,
	state: { readyState?: number; error?: MediaError | null },
) {
	if (state.readyState !== undefined)
		Object.defineProperty(video, "readyState", {
			configurable: true,
			get: () => state.readyState,
		});
	if (state.error !== undefined)
		Object.defineProperty(video, "error", {
			configurable: true,
			get: () => state.error,
		});
}

const loadingOverlay = (container: HTMLElement) =>
	container.querySelector(".z-10.bg-black.transition-opacity");

// jsdom's media track lists are not EventTargets, and Media Chrome subscribes
// to them from async store updates that can outlive a test, so they stay
// patched for this file (Vitest isolates each file's environment). Same shape
// as media-player-store-refs.test.ts.
function patchMediaTrackLists() {
	Object.defineProperty(HTMLMediaElement.prototype, "audioTracks", {
		configurable: true,
		get: () => undefined,
	});
	const textTracks = Object.assign(new EventTarget(), {
		length: 0,
		onaddtrack: null,
		onremovetrack: null,
		onchange: null,
		getTrackById: () => null,
		[Symbol.iterator]: () => ([] as TextTrack[])[Symbol.iterator](),
	}) as unknown as TextTrackList;
	Object.defineProperty(HTMLMediaElement.prototype, "textTracks", {
		configurable: true,
		get: () => textTracks,
	});
}

class NoopResizeObserver {
	observe() {}
	unobserve() {}
	disconnect() {}
}

describe("share MP4 source rendered on the server, with the real player", () => {
	beforeAll(() => {
		actEnvironment.IS_REACT_ACT_ENVIRONMENT = true;
		patchMediaTrackLists();
	});

	afterEach(() => {
		uploadState.progress = null;
		vi.unstubAllGlobals();
		document.body.replaceChildren();
	});

	afterAll(() => {
		delete actEnvironment.IS_REACT_ACT_ENVIRONMENT;
	});

	it("hydrates media that loaded first into the player controls", async () => {
		const fetchImpl = vi.fn<typeof fetch>();
		vi.stubGlobal("fetch", fetchImpl);
		vi.stubGlobal("ResizeObserver", NoopResizeObserver);
		const onUploadComplete = vi.fn();
		const { props, videoRef } = playerProps({ onUploadComplete });
		const player = await hydratePlayer(props, (video) => {
			setMediaState(video, { readyState: 3 });
			Object.defineProperty(video, "duration", {
				configurable: true,
				get: () => 95,
			});
		});
		try {
			expect(player.recoverableErrors).toEqual([]);
			expect(onUploadComplete).not.toHaveBeenCalled();
			expect(fetchImpl).not.toHaveBeenCalled();
			expect(videoRef.current).toBe(player.serverVideo);
			const seek = player.container.querySelector('[role="slider"]');
			expect(seek?.getAttribute("aria-valuemax")).toBe("95");
			expect(
				player.container.querySelector(
					'[data-slot="media-player-play-button"]',
				),
			).not.toBeNull();
			expect(loadingOverlay(player.container)?.className).toContain(
				"opacity-0",
			);
		} finally {
			await act(async () => player.root?.unmount());
			player.client.clear();
		}
	});
	it.each([true, false])(
		"switches loaded raw playback to the published source once after completion (owner=%s)",
		async (isOwner) => {
			const rawUrl = "https://media.example.test/owner/video/raw-upload.mp4";
			const publishedUrl =
				"https://media.example.test/owner/video/.recording/outputs/completed/result.mp4";
			let publish: ((response: Response) => void) | undefined;
			const fetchImpl = vi
				.fn<typeof fetch>()
				.mockResolvedValueOnce(response(SERVER_URL, 404))
				.mockResolvedValueOnce(response(rawUrl, 206, true))
				.mockImplementationOnce(
					() =>
						new Promise((resolve) => {
							publish = resolve;
						}),
				);
			vi.stubGlobal("fetch", fetchImpl);
			vi.stubGlobal("ResizeObserver", NoopResizeObserver);
			uploadState.progress = {
				status: "processing",
				lastUpdated: new Date(),
				progress: 90,
				message: "Processing video...",
			};
			const onUploadComplete = vi.fn();
			const { props, videoRef } = playerProps({
				initialPlaybackUrl: undefined,
				serverPlaybackUrl: null,
				rawFallbackSrc: "/api/playlist?videoType=raw-preview",
				hasActiveUpload: true,
				canRetryProcessing: isOwner,
				showPlaybackStatusBadge: true,
				onUploadComplete,
			});
			const player = await hydratePlayer(props);
			try {
				await act(async () => {
					await vi.waitFor(() =>
						expect(videoRef.current?.getAttribute("src")).toBe(rawUrl),
					);
					if (!videoRef.current) throw new Error("Missing raw video");
					setMediaState(videoRef.current, { readyState: 3 });
					videoRef.current.dispatchEvent(new Event("loadeddata"));
				});
				expect(onUploadComplete).not.toHaveBeenCalled();
				await act(async () => uploadState.notify?.(null));
				await settleFetch(fetchImpl, 3);
				expect(videoRef.current?.getAttribute("src")).toBe(rawUrl);
				expect(loadingOverlay(player.container)?.className).toContain(
					"opacity-0",
				);
				expect(
					player.container.querySelector(
						'[data-slot="media-player-play-button"]',
					),
				).not.toBeNull();
				expect(onUploadComplete).toHaveBeenCalledOnce();
				await act(async () => {
					publish?.(response(publishedUrl, 206, true));
					await waitForQueryNotification();
				});
				await act(async () => {
					await vi.waitFor(() =>
						expect(videoRef.current?.getAttribute("src")).toBe(publishedUrl),
					);
				});
				expect(player.container.textContent).not.toContain("Optimizing video");
				expect(retryVideoProcessing).not.toHaveBeenCalled();
				await act(async () =>
					player.root?.render(
						tree(player.client, {
							...props,
							hasActiveUpload: false,
							serverPlaybackUrl: publishedUrl,
							onUploadComplete: () => onUploadComplete(),
						}),
					),
				);
				await act(async () => {
					await waitForQueryNotification();
				});
				expect(onUploadComplete).toHaveBeenCalledOnce();
				expect(fetchImpl).toHaveBeenCalledTimes(3);
				expect(player.recoverableErrors).toEqual([]);
			} finally {
				await act(async () => player.root?.unmount());
				player.client.clear();
			}
		},
	);

	it("recovers through the playlist route when the media failed before hydration", async () => {
		const freshUrl = "https://v.cap.so/owner/video/result.mp4?Signature=fresh";
		const fetchImpl = vi
			.fn<typeof fetch>()
			.mockResolvedValueOnce(response(freshUrl, 206, true));
		vi.stubGlobal("fetch", fetchImpl);
		vi.stubGlobal("ResizeObserver", NoopResizeObserver);
		vi.stubGlobal("MediaError", {
			MEDIA_ERR_ABORTED: 1,
			MEDIA_ERR_NETWORK: 2,
			MEDIA_ERR_DECODE: 3,
			MEDIA_ERR_SRC_NOT_SUPPORTED: 4,
		});
		const { props, videoRef } = playerProps();
		const player = await hydratePlayer(props, (video) => {
			setMediaState(video, {
				readyState: 0,
				error: { code: 2, message: "network" } as MediaError,
			});
		});
		try {
			expect(player.recoverableErrors).toEqual([]);
			await settleFetch(fetchImpl, 1);
			expect(fetchImpl.mock.calls[0]?.[0]).toMatch(PLAYLIST_PROBE);
			await vi.waitFor(() => {
				expect(videoRef.current?.getAttribute("src")).toBe(freshUrl);
			});
		} finally {
			await act(async () => player.root?.unmount());
			player.client.clear();
		}
	});
	it.each([
		{ isOwner: true, playlistFallback: false },
		{ isOwner: false, playlistFallback: false },
		{ isOwner: true, playlistFallback: true },
		{ isOwner: false, playlistFallback: true },
	])(
		"shows a stale processing failure when the URL is not playable: %j",
		async ({ isOwner, playlistFallback }) => {
			vi.stubGlobal(
				"fetch",
				playlistFallback
					? vi
							.fn<typeof fetch>()
							.mockRejectedValue(
								new TypeError("Synthetic redirect CORS failure"),
							)
					: vi.fn<typeof fetch>().mockResolvedValue(response(SERVER_URL, 404)),
			);
			vi.stubGlobal("ResizeObserver", NoopResizeObserver);
			const updatedAt = new Date(Date.now() - 30 * 60000);
			uploadState.progress = {
				status: "error",
				lastUpdated: updatedAt,
				errorMessage: getStalledProcessingMessage({
					phase: "processing",
					updatedAt,
					processingProgress: 0,
					automaticRetry: false,
				}),
				hasRawFallback: false,
			};
			const { props } = playerProps({
				hasActiveUpload: true,
				canRetryProcessing: isOwner,
				...(playlistFallback
					? { serverPlaybackUrl: null, initialPlaybackUrl: undefined }
					: {}),
			});
			const player = await hydratePlayer(props);
			try {
				expect(player.container.textContent).toContain(
					"Video processing did not start. Retry processing.",
				);
				const retry = Array.from(
					player.container.querySelectorAll("button"),
				).find((button) => button.textContent === "Retry Processing");
				expect(Boolean(retry)).toBe(isOwner);
			} finally {
				await act(async () => player.root?.unmount());
				player.client.clear();
			}
		},
	);
	it.each([
		{
			isOwner: true,
			ageMs: 30 * 60000,
			automaticRetry: false,
			showRetry: true,
		},
		{
			isOwner: false,
			ageMs: 30 * 60000,
			automaticRetry: false,
			showRetry: false,
		},
		{ isOwner: true, ageMs: 30000, automaticRetry: false, showRetry: false },
		{
			isOwner: true,
			ageMs: 30 * 60000,
			automaticRetry: true,
			showRetry: false,
		},
	])(
		"retains a nonblocking recovery action while raw fallback plays: %j",
		async ({ isOwner, ageMs, automaticRetry, showRetry }) => {
			const rawUrl = "https://media.example.test/owner/video/raw-upload.mp4";
			vi.stubGlobal(
				"fetch",
				vi
					.fn<typeof fetch>()
					.mockResolvedValueOnce(response(SERVER_URL, 404))
					.mockResolvedValueOnce(response(rawUrl, 206, true)),
			);
			vi.stubGlobal("ResizeObserver", NoopResizeObserver);
			const updatedAt = new Date(Date.now() - ageMs);
			const errorMessage = getStalledProcessingMessage({
				phase: "processing",
				updatedAt,
				processingProgress: 0,
				automaticRetry,
			});
			uploadState.progress = errorMessage
				? {
						status: "error",
						lastUpdated: updatedAt,
						errorMessage,
						hasRawFallback: true,
					}
				: {
						status: "processing",
						lastUpdated: updatedAt,
						progress: 0,
						message: "Processing video...",
					};
			const { props, videoRef } = playerProps({
				initialPlaybackUrl: undefined,
				serverPlaybackUrl: null,
				rawFallbackSrc: "/api/playlist?videoType=raw-preview",
				hasActiveUpload: true,
				canRetryProcessing: isOwner,
				showPlaybackStatusBadge: true,
			});
			const player = await hydratePlayer(props);
			try {
				await act(async () => {
					await vi.waitFor(() =>
						expect(videoRef.current?.getAttribute("src")).toBe(rawUrl),
					);
					const video = videoRef.current;
					if (!video) throw new Error("Missing raw video");
					setMediaState(video, { readyState: 3 });
					Object.defineProperty(video, "duration", {
						configurable: true,
						get: () => 17.133,
					});
					video.dispatchEvent(new Event("loadedmetadata"));
					video.dispatchEvent(new Event("loadeddata"));
				});
				expect(player.recoverableErrors).toEqual([]);
				const retry = Array.from(
					player.container.querySelectorAll("button"),
				).find((button) => button.textContent === "Retry Processing");
				expect(Boolean(retry)).toBe(showRetry);
				expect(
					player.container.querySelector(
						'[data-slot="media-player-play-button"]',
					),
				).not.toBeNull();
				expect(loadingOverlay(player.container)?.className).toContain(
					"opacity-0",
				);
				if (showRetry) {
					expect(player.container.textContent).toContain("Original upload");
					const invalidate = vi.spyOn(player.client, "invalidateQueries");
					let finishRetry:
						| ((result: { success: boolean; status: "started" }) => void)
						| undefined;
					vi.mocked(retryVideoProcessing).mockImplementationOnce(
						() =>
							new Promise((resolve) => {
								finishRetry = resolve;
							}),
					);
					await act(async () => retry?.click());
					expect(retryVideoProcessing).toHaveBeenCalledExactlyOnceWith({
						videoId: props.videoId,
					});
					expect(retry?.disabled).toBe(true);
					await act(async () => retry?.click());
					expect(retryVideoProcessing).toHaveBeenCalledTimes(1);
					expect(videoRef.current?.getAttribute("src")).toBe(rawUrl);
					await act(async () =>
						finishRetry?.({ success: true, status: "started" }),
					);
					expect(invalidate).toHaveBeenCalledWith({
						queryKey: ["getUploadProgress", props.videoId],
					});
				} else expect(retryVideoProcessing).not.toHaveBeenCalled();
			} finally {
				await act(async () => player.root?.unmount());
				player.client.clear();
			}
		},
	);
});
