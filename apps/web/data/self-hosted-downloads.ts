type DownloadArtifact = { href: string; sha256: string };

export const selfHostedDownloads: Record<
	"windows" | "macosArm64" | "chrome",
	DownloadArtifact | null
> = {
	windows: null,
	macosArm64: null,
	chrome: {
		href: "/downloads/v0.6.1-tam.1/TAMCap-Chrome.zip",
		sha256: "3d5374db2ed5a03daaee803a69d5a3cccb7851e053537a946b03f3b1a8d804e8",
	},
};
