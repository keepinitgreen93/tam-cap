type DownloadArtifact = { href: string };

export const selfHostedDownloads: Record<
	"windows" | "macosArm64" | "chrome",
	DownloadArtifact | null
> = {
	windows: {
		href: "/downloads/v0.6.1-tam.2/TAMCap-Windows-x64-setup.exe",
	},
	macosArm64: {
		href: "/downloads/v0.6.1-tam.2/TAMCap-macOS-arm64.dmg",
	},
	chrome: {
		href: "/downloads/v0.6.1-tam.1/TAMCap-Chrome.zip",
	},
};
