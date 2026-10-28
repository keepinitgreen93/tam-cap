export const metadata = {
	title: "Cap desktop approved",
	referrer: "no-referrer",
};

export default function DesktopCompletePage() {
	return (
		<main className="flex min-h-screen items-center justify-center bg-gray-2 px-6">
			<section className="w-full max-w-md rounded-2xl border border-gray-4 bg-white p-8 shadow-sm">
				<h1 className="text-xl font-semibold text-gray-12">
					Desktop sign-in approved
				</h1>
				<p className="mt-3 text-sm leading-6 text-gray-10">
					Return to Cap to finish signing in. You can close this tab. If Cap no
					longer shows a pending sign-in, start again from the app.
				</p>
			</section>
		</main>
	);
}
