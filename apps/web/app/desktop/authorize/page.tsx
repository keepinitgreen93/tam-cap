import { getCurrentUser } from "@cap/database/auth/session";
import { db } from "@cap/database/cloudflare/application";
import {
	approveDesktopSignIn,
	desktopSignInIdIsValid,
	limitDesktopSignIn,
} from "@cap/database/cloudflare/desktop-sign-in";
import { desktopSignInRequests } from "@cap/database/cloudflare/schema";
import { serverEnv } from "@cap/env";
import { eq } from "drizzle-orm";
import { headers } from "next/headers";
import { redirect } from "next/navigation";

export const dynamic = "force-dynamic";
export const metadata = {
	title: "Sign in to Cap desktop",
	referrer: "no-referrer",
};

export default async function DesktopAuthorizePage(props: {
	searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
	const params = await props.searchParams;
	const requestId = typeof params.request === "string" ? params.request : "";
	const valid =
		process.env.CAP_RUNTIME === "cloudflare" &&
		desktopSignInIdIsValid(requestId);
	const [request] = valid
		? await db()
				.select()
				.from(desktopSignInRequests)
				.where(eq(desktopSignInRequests.id, requestId))
		: [];
	const active = request && request.expiresAt.getTime() > Date.now();
	const user = active ? await getCurrentUser() : null;
	if (active && !user)
		redirect(
			`/login?next=${encodeURIComponent(`/desktop/authorize?request=${requestId}`)}`,
		);

	async function approve(formData: FormData) {
		"use server";
		const origin = (await headers()).get("origin");
		if (!origin || origin !== new URL(serverEnv().WEB_URL).origin)
			throw new Error("Invalid request origin");
		const currentUser = await getCurrentUser();
		if (!currentUser) redirect("/login");
		const submittedId = formData.get("requestId");
		if (typeof submittedId !== "string" || !desktopSignInIdIsValid(submittedId))
			throw new Error("Invalid sign-in request");
		await limitDesktopSignIn(db(), `approve:${currentUser.id}`, 10);
		await approveDesktopSignIn(db(), submittedId, currentUser.id);
		redirect("/desktop/complete");
	}

	return (
		<main className="flex min-h-screen items-center justify-center bg-gray-2 px-6">
			<section className="w-full max-w-md rounded-2xl border border-gray-4 bg-white p-8 shadow-sm">
				<h1 className="text-xl font-semibold text-gray-12">
					{active ? "Sign in to Cap desktop" : "Sign-in request expired"}
				</h1>
				<p className="mt-3 text-sm leading-6 text-gray-10">
					{active
						? `Continue as ${user?.email}. Only approve if you just clicked Sign in in your Cap desktop app.`
						: "Return to Cap and start sign-in again."}
				</p>
				{active && !request.userId && (
					<form action={approve} className="mt-6">
						<input type="hidden" name="requestId" value={requestId} />
						<button
							type="submit"
							className="rounded-lg bg-blue-9 px-5 py-3 text-white"
						>
							Approve desktop sign-in
						</button>
					</form>
				)}
				{active && request.userId && (
					<p className="mt-6 text-sm text-gray-10">
						This request has already been approved. Return to Cap.
					</p>
				)}
			</section>
		</main>
	);
}
