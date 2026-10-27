import { buildEnv } from "@cap/env";
import type { Metadata } from "next";
import { DownloadPage } from "@/components/pages/DownloadPage";
import { SelfHostedDownloadPage } from "@/components/pages/SelfHostedDownloadPage";
import { buildMarketingMetadata } from "@/lib/og/url";
import { nativeDesktopReleaseIsLive } from "@/utils/native-release";
import { getGitHubReleases } from "@/utils/releases";

export const metadata: Metadata = buildMarketingMetadata({
	title: "Download — Cap",
	path: "/download",
	ogTitle: "Download Cap for macOS, Windows, Linux & Chrome",
	ogTag: "Download",
});

export const revalidate = 60;

export default async function App() {
	if (buildEnv.NEXT_PUBLIC_IS_CAP !== "true") return <SelfHostedDownloadPage />;
	const releases = await getGitHubReleases().catch(() => []);
	return (
		<DownloadPage nativeReleaseLive={nativeDesktopReleaseIsLive(releases)} />
	);
}
