import { Button } from "@cap/ui/button";
import Link from "next/link";
import { selfHostedDownloads } from "@/data/self-hosted-downloads";

function PackageLink({
	platform,
	label,
}: {
	platform: keyof typeof selfHostedDownloads;
	label: string;
}) {
	const artifact = selfHostedDownloads[platform];
	return artifact ? (
		<Button href={artifact.href} variant="dark" size="lg">
			{label}
		</Button>
	) : (
		<p className="text-sm text-gray-10">This package is being verified.</p>
	);
}

export function SelfHostedDownloadPage() {
	return (
		<main className="mx-auto max-w-4xl px-6 py-16 text-gray-12">
			<h1 className="text-4xl font-semibold tracking-tight">Install TAM Cap</h1>
			<p className="mt-4 max-w-2xl text-lg text-gray-10">
				Record from your desktop or Chrome and share through your team
				workspace.
			</p>
			<div className="mt-10 grid gap-6 sm:grid-cols-2">
				<section className="rounded-2xl border border-gray-5 bg-gray-1 p-6">
					<h2 className="text-xl font-medium">Windows</h2>
					<p className="mb-6 mt-2 text-gray-10">
						Desktop recorder and editor for Windows 10 or later.
					</p>
					<PackageLink platform="windows" label="Download for Windows" />
				</section>
				<section className="rounded-2xl border border-gray-5 bg-gray-1 p-6">
					<h2 className="text-xl font-medium">macOS</h2>
					<p className="mb-6 mt-2 text-gray-10">
						Desktop recorder and editor for Apple Silicon Macs.
					</p>
					<PackageLink platform="macosArm64" label="Download for macOS" />
				</section>
			</div>
			{/* biome-ignore lint/correctness/useUniqueElementIds: Stable page anchor for installation links. */}
			<section
				id="chrome"
				className="mt-6 rounded-2xl border border-gray-5 bg-gray-1 p-6"
			>
				<h2 className="text-xl font-medium">Chrome extension</h2>
				<p className="mb-6 mt-2 text-gray-10">
					Record a tab, window, or screen without leaving Chrome.
				</p>
				<PackageLink platform="chrome" label="Download Chrome extension" />
				<ol className="mt-6 list-inside list-decimal space-y-2 text-sm text-gray-10">
					<li>Unzip the downloaded extension into a folder you will keep.</li>
					<li>
						Open <code>chrome://extensions</code> and enable Developer mode.
					</li>
					<li>Choose Load unpacked, select the folder, and pin TAM Cap.</li>
					<li>Open the extension and sign in to your team workspace.</li>
				</ol>
			</section>
			<section className="mt-10 space-y-3">
				<h2 className="text-xl font-medium">Your team server</h2>
				<p className="text-gray-10">
					These packages connect here automatically. If you change the server
					setting, use:
				</p>
				<code className="block break-all rounded-lg bg-gray-3 px-4 py-3 text-sm">
					https://videos.trulyauthenticmarketing.com
				</code>
				<p className="text-sm text-gray-10">
					Updates for these team builds are managed by your administrator.
				</p>
				<p className="text-sm text-gray-10">
					Built from our Cap fork.{" "}
					<a
						href="https://github.com/keepinitgreen93/tam-cap/tree/codex/cloudflare-self-host"
						className="underline"
					>
						Source code and license
					</a>
					.
				</p>
				<Link
					href="/dashboard/caps/record"
					className="inline-block text-sm font-medium text-blue-10 underline"
				>
					Record in your browser
				</Link>
			</section>
		</main>
	);
}
