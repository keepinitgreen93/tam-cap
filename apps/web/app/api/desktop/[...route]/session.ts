import { decodeSessionToken } from "@cap/database/auth/auth-options";
import { getCurrentUser } from "@cap/database/auth/session";
import {
	requireWorkspaceAccount,
	WorkspaceAccountRequiredError,
} from "@cap/database/cloudflare/access";
import { db } from "@cap/database/cloudflare/application";
import { atomic } from "@cap/database/cloudflare/atomic";
import {
	DesktopSignInError,
	limitDesktopSignIn,
	pollDesktopSignIn,
	startDesktopSignIn,
} from "@cap/database/cloudflare/desktop-sign-in";
import { authApiKeys } from "@cap/database/cloudflare/schema";
import { serverEnv } from "@cap/env";
import { zValidator } from "@hono/zod-validator";
import { Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import { getCookie } from "hono/cookie";
import { z } from "zod";
import {
	buildLoopbackCallbackUrl,
	createDesktopRedirectPage,
	desktopSessionRequestQuerySchema,
} from "@/lib/desktop-session";

export const app = new Hono();

app.use(
	"/device/*",
	bodyLimit({
		maxSize: 4096,
		onError: (c) =>
			c.json({ error: "request_too_large" }, 413, {
				"Cache-Control": "no-store",
				"Referrer-Policy": "no-referrer",
			}),
	}),
);

app.onError((error, c) => {
	if (error instanceof DesktopSignInError)
		return c.json(
			{ error: error.code },
			error.code === "invalid_request" ? 400 : 429,
		);
	if (error instanceof WorkspaceAccountRequiredError)
		return c.json({ error: "workspace_membership_required" }, 403);
	throw error;
});

app.use("/device/*", async (c, next) => {
	c.header("Cache-Control", "no-store");
	c.header("Referrer-Policy", "no-referrer");
	if (process.env.CAP_RUNTIME !== "cloudflare")
		return c.json({ error: "not_found" }, 404);
	if (new URL(serverEnv().WEB_URL).protocol !== "https:")
		return c.json({ error: "https_required" }, 400);
	if (c.req.header("origin"))
		return c.json({ error: "desktop_client_required" }, 403);
	try {
		const address =
			c.req.header("cf-connecting-ip") ??
			c.req.header("x-forwarded-for")?.split(",")[0]?.trim() ??
			"unknown";
		await limitDesktopSignIn(
			db(),
			`${c.req.path}:${address}`,
			c.req.path.endsWith("/start") ? 10 : 120,
		);
		await next();
	} catch (error) {
		if (error instanceof DesktopSignInError)
			return c.json(
				{ error: error.code },
				error.code === "invalid_request" ? 400 : 429,
			);
		if (error instanceof WorkspaceAccountRequiredError)
			return c.json({ error: "workspace_membership_required" }, 403);
		throw error;
	}
});

app.post(
	"/device/start",
	zValidator("json", z.object({ codeChallenge: z.string().max(43) })),
	async (c) => {
		const request = await startDesktopSignIn(
			db(),
			c.req.valid("json").codeChallenge,
		);
		return c.json(request);
	},
);

app.post(
	"/device/poll",
	zValidator(
		"json",
		z.object({ requestId: z.string().max(64), verifier: z.string().max(43) }),
	),
	async (c) => {
		const { requestId, verifier } = c.req.valid("json");
		return c.json(await pollDesktopSignIn(db(), requestId, verifier));
	},
);

app.get(
	"/request",
	zValidator("query", desktopSessionRequestQuerySchema),
	async (c) => {
		if (process.env.CAP_RUNTIME === "cloudflare") {
			return c.html(
				'<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Update Cap to sign in</title><body style="font-family:system-ui;max-width:34rem;margin:15vh auto;padding:24px"><h1>Update Cap to sign in securely</h1><p>This desktop version uses an older sign-in flow. Download the latest app, then sign in again from Cap.</p><a href="/download">Download Cap</a></body></html>',
				426,
				{ "Cache-Control": "no-store", "Referrer-Policy": "no-referrer" },
			);
		}
		const { port, platform, type } = c.req.valid("query");

		const secret = serverEnv().NEXTAUTH_SECRET;

		const url = new URL(c.req.url);

		const redirectOrigin = getDeploymentOrigin();

		const loginRedirectUrl = new URL(`${redirectOrigin}/login`);
		loginRedirectUrl.searchParams.set(
			"next",
			new URL(`${redirectOrigin}${url.pathname}${url.search}`).toString(),
		);

		const user = await getCurrentUser();
		if (!user) return c.redirect(loginRedirectUrl);
		try {
			await atomic(db(), async (snapshot) => ({
				statements: [],
				result: await requireWorkspaceAccount(snapshot, user.id),
			}));
		} catch (error) {
			if (error instanceof WorkspaceAccountRequiredError)
				return c.json({ error: "workspace_membership_required" }, 403);
			throw error;
		}

		let data:
			| { type: "token"; token: string; expires: string }
			| { type: "api_key"; api_key: string };

		if (type === "session") {
			const token = getCookie(c, "next-auth.session-token");
			if (token === undefined) return c.redirect(loginRedirectUrl);

			const decodedToken = await decodeSessionToken({ token, secret });

			if (!decodedToken) return c.redirect(loginRedirectUrl);

			data = {
				type: "token",
				token,
				expires: String(decodedToken.exp),
			};
		} else {
			const id = crypto.randomUUID();
			const database = db();
			await atomic(database, async (snapshot) => {
				await requireWorkspaceAccount(snapshot, user.id);
				return {
					statements: [
						database
							.insert(authApiKeys)
							.values({ id, userId: user.id, source: "desktop" }),
					],
					result: undefined,
				};
			});

			data = { type: "api_key", api_key: id };
		}

		const params = new URLSearchParams({ ...data, user_id: user.id });
		const localhostUrl =
			port !== undefined ? buildLoopbackCallbackUrl(port, params) : undefined;
		const deepLinkUrl = `cap-desktop://signin?${params}`;

		if (platform === "web" && localhostUrl) {
			return Response.redirect(localhostUrl);
		}

		if (platform === "desktop" && localhostUrl) {
			return new Response(
				createDesktopRedirectPage(deepLinkUrl, localhostUrl),
				{
					headers: {
						"Content-Type": "text/html; charset=utf-8",
						"Cache-Control": "no-store, no-cache, must-revalidate",
						Pragma: "no-cache",
					},
				},
			);
		}

		return Response.redirect(deepLinkUrl);
	},
);

function getDeploymentOrigin() {
	const webUrl = serverEnv().WEB_URL;
	const vercelEnv = serverEnv().VERCEL_ENV;

	if (!vercelEnv || vercelEnv === "production") {
		return webUrl;
	}

	if (vercelEnv === "preview") {
		const branchHost = serverEnv().VERCEL_BRANCH_URL_HOST;
		if (branchHost?.endsWith(".vercel.app")) {
			return `https://${branchHost}`;
		}
	}

	return webUrl;
}
