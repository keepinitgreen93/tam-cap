import { isCrossSiteCookieWrite } from "@cap/database/auth/request-site";
import { getCurrentUser } from "@cap/database/auth/session";
import { db } from "@cap/database/cloudflare/application";
import { resolveCloudflareInvite } from "@cap/database/cloudflare/team";
import { type NextRequest, NextResponse } from "next/server";
export async function POST(request: NextRequest) {
	const user = isCrossSiteCookieWrite(request) ? null : await getCurrentUser();
	if (!user) {
		return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
	}

	let inviteId: unknown;
	try {
		({ inviteId } = await request.json());
	} catch {
		return NextResponse.json(
			{ error: "Invalid request body" },
			{ status: 400 },
		);
	}

	if (typeof inviteId !== "string" || !inviteId) {
		return NextResponse.json({ error: "Invalid invite ID" }, { status: 400 });
	}

	try {
		await resolveCloudflareInvite(db(), {
			userId: user.id,
			inviteId,
			accept: false,
		});

		return NextResponse.json({ success: true });
	} catch (error) {
		if (error instanceof Error) {
			if (error.message === "INVITE_EXPIRED")
				return NextResponse.json(
					{ error: "Invitation has expired or was revoked" },
					{ status: 400 },
				);
			if (error.message === "INVITE_NOT_FOUND") {
				return NextResponse.json(
					{ error: "Invite not found" },
					{ status: 404 },
				);
			}
			if (error.message === "EMAIL_MISMATCH") {
				return NextResponse.json({ error: "Email mismatch" }, { status: 403 });
			}
		}
		console.error("Error declining invite:", error);
		return NextResponse.json(
			{ error: "Internal server error" },
			{ status: 500 },
		);
	}
}
