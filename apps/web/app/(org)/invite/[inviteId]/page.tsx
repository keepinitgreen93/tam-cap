import {
	getCurrentUser,
	type userSelectProps,
} from "@cap/database/auth/session";
import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { getInviteDetails } from "@/lib/organization-invite-read";
import { InviteAccept } from ".//InviteAccept";

type Props = {
	params: Promise<{ inviteId: string }>;
};

export async function generateMetadata(props: Props): Promise<Metadata> {
	const params = await props.params;
	const inviteId = params.inviteId;
	const invite = await getInviteDetails(inviteId);

	if (!invite) {
		return notFound();
	}

	return {
		title: `Join ${invite.organizationName} on Cap`,
		description: `You've been invited to join ${invite.organizationName} on Cap.`,
	};
}

export default async function InvitePage(props: Props) {
	const params = await props.params;
	const inviteId = params.inviteId;
	const user = await getCurrentUser();
	const inviteDetails = await getInviteDetails(inviteId);

	if (!inviteDetails) {
		return notFound();
	}

	if (!inviteDetails.organizationName || !inviteDetails.inviterName) {
		return notFound();
	}

	return (
		<InviteAccept
			inviteId={inviteId}
			organizationName={inviteDetails.organizationName}
			inviterName={inviteDetails.inviterName}
			user={user as typeof userSelectProps | null}
		/>
	);
}
