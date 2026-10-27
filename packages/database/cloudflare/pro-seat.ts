import type { Organisation, User } from "@cap/web-domain";
import { and, eq, exists, inArray, isNotNull, ne, sql } from "drizzle-orm";
import { alias } from "drizzle-orm/sqlite-core";
import type { CloudflareDatabase } from "./index.ts";
import { organizationMembers, organizations, users } from "./schema.ts";

export function releaseProSeatStatement(
	database: CloudflareDatabase,
	userId: User.UserId,
) {
	const sponsor = alias(users, "sponsor");
	const seats = () =>
		database
			.select({ subscription: sponsor.stripeSubscriptionId })
			.from(organizationMembers)
			.innerJoin(
				organizations,
				eq(organizationMembers.organizationId, organizations.id),
			)
			.innerJoin(sponsor, eq(organizations.ownerId, sponsor.id));
	const memberCondition = and(
		eq(organizationMembers.userId, userId),
		eq(organizationMembers.hasProSeat, true),
	);
	const paidSeat = seats()
		.where(and(memberCondition, isNotNull(sponsor.stripeSubscriptionId)))
		.limit(1);
	const remainingSeats = seats().where(memberCondition).limit(1);
	return database
		.update(users)
		.set({
			thirdPartyStripeSubscriptionId: sql`case when ${exists(paidSeat)} then ${paidSeat} when ${exists(remainingSeats)} then ${users.thirdPartyStripeSubscriptionId} else null end`,
		})
		.where(eq(users.id, userId));
}

export function releaseOrganizationProSeatsStatement(
	database: CloudflareDatabase,
	organizationId: Organisation.OrganisationId,
) {
	const sponsor = alias(users, "sponsor");
	const seats = () =>
		database
			.select({ subscription: sponsor.stripeSubscriptionId })
			.from(organizationMembers)
			.innerJoin(
				organizations,
				eq(organizationMembers.organizationId, organizations.id),
			)
			.innerJoin(sponsor, eq(organizations.ownerId, sponsor.id));
	const memberCondition = and(
		eq(organizationMembers.userId, users.id),
		eq(organizationMembers.hasProSeat, true),
		ne(organizationMembers.organizationId, organizationId),
	);
	const paidSeat = seats()
		.where(and(memberCondition, isNotNull(sponsor.stripeSubscriptionId)))
		.limit(1);
	const remainingSeats = seats().where(memberCondition).limit(1);
	const affected = database
		.select({ id: organizationMembers.userId })
		.from(organizationMembers)
		.where(
			and(
				eq(organizationMembers.organizationId, organizationId),
				eq(organizationMembers.hasProSeat, true),
			),
		);
	return database
		.update(users)
		.set({
			thirdPartyStripeSubscriptionId: sql`case when ${exists(paidSeat)} then ${paidSeat} when ${exists(remainingSeats)} then ${users.thirdPartyStripeSubscriptionId} else null end`,
		})
		.where(inArray(users.id, affected));
}
