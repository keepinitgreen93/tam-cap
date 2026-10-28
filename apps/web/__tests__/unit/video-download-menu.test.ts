import { Video } from "@cap/web-domain";
import { createElement, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { expect, it, vi } from "vitest";

vi.mock("@cap/ui", () => {
	const wrapper = ({ children }: { children: ReactNode }) =>
		createElement("div", null, children);
	return {
		DropdownMenu: wrapper,
		DropdownMenuContent: wrapper,
		DropdownMenuItem: wrapper,
		DropdownMenuTrigger: wrapper,
	};
});
vi.mock("@/app/s/[videoId]/_components/use-video-download", () => ({
	useVideoDownload: () => ({ download: vi.fn(), isDownloading: false }),
}));

import { VideoDownloadMenu } from "@/app/s/[videoId]/_components/VideoDownloadMenu";

it("does not offer retained originals in a reader's download menu", () => {
	const html = renderToStaticMarkup(
		createElement(VideoDownloadMenu, {
			videoId: Video.VideoId.make("recording"),
			hasEdits: true,
			allowOriginal: false,
		}),
	);
	expect(html).toContain("Download video");
	expect(html).not.toContain("Download original video");
});

it("preserves both edited and original choices in the owner's editor", () => {
	const html = renderToStaticMarkup(
		createElement(VideoDownloadMenu, {
			videoId: Video.VideoId.make("recording"),
			hasEdits: true,
		}),
	);
	expect(html).toContain("Download current video");
	expect(html).toContain("Download original video");
});
