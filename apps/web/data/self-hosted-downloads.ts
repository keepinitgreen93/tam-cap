type DownloadArtifact = { href: string; sha256: string };

export const selfHostedDownloads: Record<
	"windows" | "macosArm64" | "chrome",
	DownloadArtifact | null
> = {
	windows: {
		href: "/downloads/v0.6.1-tam.1/TAMCap-Windows-x64-setup.exe",
		sha256: "e8d7abfa166bedd11e524d20b74cfc8aef7a21fc3ce1d009fe753f4d1a1a4849",
	},
	macosArm64: {
		href: "/downloads/v0.6.1-tam.1/TAMCap-macOS-arm64.dmg",
		sha256: "cd427f3c53791cf681e8990facd38ceb0186dff7f9805933c58a4b99c0481cd5",
	},
	chrome: {
		href: "/downloads/v0.6.1-tam.1/TAMCap-Chrome.zip",
		sha256: "3d5374db2ed5a03daaee803a69d5a3cccb7851e053537a946b03f3b1a8d804e8",
	},
};
