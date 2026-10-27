import { buildEnv } from "@cap/env";
import "@cap/ui/style";
import Link from "next/link";
import type { PropsWithChildren } from "react";
import { formatStarCount, getGitHubStars } from "@/utils/github";
import { DeferredMessengerWidget } from "../Layout/DeferredMessengerWidget";
import { Footer } from "./Footer";
import { Navbar } from "./Navbar";

export default async function Layout(props: PropsWithChildren) {
	if (buildEnv.NEXT_PUBLIC_IS_CAP !== "true")
		return (
			<>
				<header className="mx-auto flex max-w-4xl items-center justify-between px-6 py-6 text-gray-12">
					<Link href="/dashboard" className="font-semibold">
						TAM Videos
					</Link>
					<Link href="/dashboard" className="text-sm underline">
						Open workspace
					</Link>
				</header>
				{props.children}
				<footer className="mx-auto max-w-4xl px-6 py-8 text-sm text-gray-10">
					Based on Cap. Copyright Cap Software, Inc.{" "}
					<a
						href="https://github.com/keepinitgreen93/tam-cap/tree/codex/cloudflare-self-host"
						className="underline"
					>
						Source code
					</a>
					.
				</footer>
			</>
		);
	const starCount = await getGitHubStars();
	const stars = formatStarCount(starCount);

	return (
		<>
			<Navbar stars={stars} />
			{props.children}
			<Footer />
			{buildEnv.NEXT_PUBLIC_IS_CAP === "true" && <DeferredMessengerWidget />}
		</>
	);
}
