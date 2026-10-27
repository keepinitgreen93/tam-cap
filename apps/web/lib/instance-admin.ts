import "server-only";
import { normalizeEmail } from "@cap/database/auth/identity";
import { MESSENGER_ADMIN_EMAIL } from "@/lib/messenger/constants";

export function isInstanceAdmin(
	user: { email: string; emailVerified?: Date | null } | null | undefined,
) {
	if (!user) return false;
	if (process.env.CAP_RUNTIME !== "cloudflare")
		return normalizeEmail(user.email) === normalizeEmail(MESSENGER_ADMIN_EMAIL);
	const ownerEmail = process.env.CAP_OWNER_EMAIL;
	return Boolean(
		user.emailVerified &&
			ownerEmail &&
			normalizeEmail(user.email) === normalizeEmail(ownerEmail),
	);
}
