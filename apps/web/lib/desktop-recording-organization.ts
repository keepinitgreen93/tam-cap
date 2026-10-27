import type { CloudflareDatabase } from "@cap/database/cloudflare";
import { requireWorkspaceAccount } from "@cap/database/cloudflare/access";
import { atomic } from "@cap/database/cloudflare/atomic";
import {
	organizationMembers,
	organizations,
	users,
} from "@cap/database/cloudflare/schema";
import type { Organisation, User } from "@cap/web-domain";
import { and, eq, isNull } from "drizzle-orm";

export function ensureRecordingOrganization(
	database: CloudflareDatabase,
	userId: User.UserId,
	organizationId: Organisation.OrganisationId,
	membershipId: string,
) {
	return atomic<{
		id: Organisation.OrganisationId;
		name: string;
		created: boolean;
	}>(database, async (snapshot) => {
		const [user] = await snapshot.read((reader) =>
			reader
				.select({ id: users.id })
				.from(users)
				.where(eq(users.id, userId))
				.limit(1),
		);
		if (!user) throw new Error("Recording owner is unavailable");
		const [owned] = await snapshot.read((reader) =>
			reader
				.select({ id: organizations.id, name: organizations.name })
				.from(organizations)
				.where(
					and(
						eq(organizations.ownerId, userId),
						isNull(organizations.tombstoneAt),
					),
				)
				.limit(1),
		);
		if (owned) return { statements: [], result: { ...owned, created: false } };
		const [member] = await snapshot.read((reader) =>
			reader
				.select({ id: organizations.id, name: organizations.name })
				.from(organizationMembers)
				.innerJoin(
					organizations,
					eq(organizations.id, organizationMembers.organizationId),
				)
				.where(
					and(
						eq(organizationMembers.userId, userId),
						isNull(organizations.tombstoneAt),
					),
				)
				.limit(1),
		);
		if (member)
			return { statements: [], result: { ...member, created: false } };
		await requireWorkspaceAccount(snapshot, userId);
		return {
			statements: [
				database.insert(organizations).values({
					id: organizationId,
					ownerId: userId,
					name: "My Organization",
				}),
				database
					.insert(organizationMembers)
					.values({ id: membershipId, organizationId, userId, role: "owner" }),
				database
					.update(users)
					.set({
						activeOrganizationId: organizationId,
						defaultOrgId: organizationId,
					})
					.where(eq(users.id, userId)),
			],
			result: { id: organizationId, name: "My Organization", created: true },
		};
	});
}
