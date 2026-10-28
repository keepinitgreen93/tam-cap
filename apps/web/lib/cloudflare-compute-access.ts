import { isCrossSiteCookieWrite } from "@cap/database/auth/request-site";
import { getCurrentUser } from "@cap/database/auth/session";
import {
	requireWorkspaceAccount,
	WorkspaceAccountRequiredError,
} from "@cap/database/cloudflare/access";
import { db } from "@cap/database/cloudflare/application";
import { atomic } from "@cap/database/cloudflare/atomic";

export async function getCloudflareComputeDenial(request: Request) {
	if (process.env.CAP_RUNTIME !== "cloudflare") return;
	if (
		isCrossSiteCookieWrite({
			method: "POST",
			url: request.url,
			headers: request.headers,
		})
	)
		return Response.json({ error: "Unauthorized" }, { status: 401 });
	const user = await getCurrentUser();
	if (!user) return Response.json({ error: "Unauthorized" }, { status: 401 });
	try {
		await atomic(db(), async (snapshot) => ({
			statements: [],
			result: await requireWorkspaceAccount(snapshot, user.id),
		}));
	} catch (error) {
		if (!(error instanceof WorkspaceAccountRequiredError)) throw error;
		return Response.json(
			{ error: "Workspace access required" },
			{ status: 403 },
		);
	}
}
