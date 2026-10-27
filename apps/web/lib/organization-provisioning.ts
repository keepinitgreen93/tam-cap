import "server-only";
import { db } from "@cap/database/cloudflare/application";
import { provisionCloudflareInvitee } from "@cap/database/cloudflare/team";
import type { Organisation, User } from "@cap/web-domain";

export async function provisionOrganizationInvitee(input: {
	organizationId: Organisation.OrganisationId;
	email: string;
	invitedByUserId: User.UserId;
	role: "admin" | "member";
}) {
	return provisionCloudflareInvitee(db(), input);
}
