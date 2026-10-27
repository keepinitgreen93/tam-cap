import "server-only";

import { randomUUID } from "node:crypto";
import { cloudflareAccessPolicy } from "@cap/database/auth/identity";
import { getCurrentUser } from "@cap/database/auth/session";
import { requireActiveOrganization } from "@cap/database/cloudflare/access";
import { db } from "@cap/database/cloudflare/application";
import { type AtomicSnapshot, atomic } from "@cap/database/cloudflare/atomic";
import {
	loomMigrationRequests,
	organizations,
	users,
} from "@cap/database/cloudflare/schema";
import { buildEnv } from "@cap/env";
import type { Organisation, User } from "@cap/web-domain";
import {
	and,
	asc,
	desc,
	eq,
	gt,
	isNotNull,
	isNull,
	ne,
	sql,
} from "drizzle-orm";
import { requireOrganizationSettingsManager } from "@/actions/organization/authorization";
import { isInstanceAdmin } from "@/lib/instance-admin";
import { MESSENGER_ADMIN_EMAIL } from "@/lib/messenger/constants";
import { isOrganizationOwnerPro } from "@/lib/org-pro";
import {
	LoomMigrationError,
	type LoomMigrationResult,
	type LoomMigrationStatus,
} from "./loom-migration-state";

type MigrationRecord = typeof loomMigrationRequests.$inferSelect;
const IMPORT_LEASE_MS = 60 * 60 * 1000;

export type LoomMigrationView = {
	id: string;
	organizationId: Organisation.OrganisationId;
	status: LoomMigrationStatus;
	workspaceName: string | null;
	customerNote: string | null;
	customerReply: string | null;
	invitedAt: string | null;
	capMessage: string | null;
	expectedVideoCount: number | null;
	importedVideoCount: number;
	queuedVideoCount: number;
	activeImportCount: number;
	completedAt: string | null;
	createdAt: string;
	updatedAt: string;
};

export type OperatorLoomMigrationView = LoomMigrationView & {
	organizationName: string;
	requestedByEmail: string;
};

export async function toLoomMigrationResult<T>(
	run: () => Promise<T>,
): Promise<LoomMigrationResult<T>> {
	try {
		return { ok: true, value: await run() };
	} catch (error) {
		if (error instanceof LoomMigrationError) {
			return { ok: false, error: error.message };
		}
		throw error;
	}
}

export function migrationToView(record: MigrationRecord): LoomMigrationView {
	return {
		id: record.id,
		organizationId: record.organizationId,
		status: record.status,
		workspaceName: record.workspaceName,
		customerNote: record.customerNote,
		customerReply: record.customerReply,
		invitedAt: record.invitedAt?.toISOString() ?? null,
		capMessage: record.capMessage,
		expectedVideoCount: record.expectedVideoCount,
		importedVideoCount: record.importedVideoCount,
		queuedVideoCount: record.queuedVideoCount,
		activeImportCount:
			record.activeImportLeaseUntil &&
			record.activeImportLeaseUntil.getTime() <= Date.now()
				? 0
				: record.activeImportCount,
		completedAt: record.completedAt?.toISOString() ?? null,
		createdAt: record.createdAt.toISOString(),
		updatedAt: record.updatedAt.toISOString(),
	};
}

export async function requireCustomerMigrationAccess(
	organizationId: Organisation.OrganisationId,
) {
	const user = await getCurrentUser();
	if (!user) throw new LoomMigrationError("Unauthorized");
	await requireOrganizationSettingsManager(user.id, organizationId);
	return user;
}

export async function requireProCustomerMigrationAccess(
	organizationId: Organisation.OrganisationId,
) {
	const user = await requireCustomerMigrationAccess(organizationId);
	if (
		process.env.CAP_RUNTIME !== "cloudflare" &&
		buildEnv.NEXT_PUBLIC_IS_CAP !== "true"
	) {
		throw new LoomMigrationError(
			"Concierge migration is available on Cap Cloud.",
		);
	}
	if (!(await isOrganizationOwnerPro(organizationId))) {
		throw new LoomMigrationError("Concierge Loom migration requires Cap Pro.");
	}
	return user;
}

export async function requireMigrationOperator() {
	const user = await getCurrentUser();
	if (!user || !isInstanceAdmin(user))
		throw new LoomMigrationError("Unauthorized");
	return user;
}

export async function resolveTrustedMigrationOperator() {
	const email =
		process.env.CAP_RUNTIME === "cloudflare"
			? cloudflareAccessPolicy().ownerEmail
			: MESSENGER_ADMIN_EMAIL;
	const [operator] = await db()
		.select()
		.from(users)
		.where(eq(users.email, email))
		.limit(1);
	if (!operator || !isInstanceAdmin(operator))
		throw new LoomMigrationError("Unauthorized");
	return operator;
}

export async function assertMigrationOperator(
	snapshot: AtomicSnapshot,
	userId: User.UserId,
) {
	const [user] = await snapshot.read((reader) =>
		reader.select().from(users).where(eq(users.id, userId)).limit(1),
	);
	if (!user || !isInstanceAdmin(user))
		throw new LoomMigrationError("Unauthorized");
	return user;
}

export async function reserveConciergeImport(
	requestId: string,
	operatorId: User.UserId,
) {
	const token = randomUUID();
	const now = new Date();
	const database = db();
	await atomic(database, async (snapshot) => {
		await assertMigrationOperator(snapshot, operatorId);
		const [request] = await snapshot.read((reader) =>
			reader
				.select()
				.from(loomMigrationRequests)
				.where(eq(loomMigrationRequests.id, requestId))
				.limit(1),
		);
		if (
			!request ||
			request.activeOrganizationId !== request.organizationId ||
			(request.activeImportCount > 0 &&
				(!request.activeImportLeaseUntil ||
					request.activeImportLeaseUntil > now))
		)
			throw new LoomMigrationError(
				"The migration request changed or another import is starting. Refresh and try again.",
			);
		await requireActiveOrganization(snapshot, request.organizationId);
		return {
			statements: [
				database
					.update(loomMigrationRequests)
					.set({
						activeImportCount: 1,
						activeImportLeaseToken: token,
						activeImportLeaseUntil: new Date(now.getTime() + IMPORT_LEASE_MS),
						status:
							request.status === "pending" ? "in_progress" : request.status,
						lastOperatorUserId: operatorId,
						lastOperatorAt: now,
						updatedAt: now,
					})
					.where(eq(loomMigrationRequests.id, requestId)),
			],
			result: undefined,
		};
	});
	return token;
}

export async function releaseConciergeImport(requestId: string, token: string) {
	await db()
		.update(loomMigrationRequests)
		.set({
			activeImportCount: 0,
			activeImportLeaseToken: null,
			activeImportLeaseUntil: null,
			updatedAt: new Date(),
		})
		.where(
			and(
				eq(loomMigrationRequests.id, requestId),
				eq(loomMigrationRequests.activeImportLeaseToken, token),
			),
		);
}

export async function renewConciergeImport(requestId: string, token: string) {
	const now = new Date();
	const deadline = new Date(now.getTime() + IMPORT_LEASE_MS);
	const result = await db()
		.update(loomMigrationRequests)
		.set({
			activeImportLeaseUntil: sql`max(${loomMigrationRequests.activeImportLeaseUntil}, ${deadline.getTime()}) + 1000`,
			updatedAt: now,
		})
		.where(
			and(
				eq(loomMigrationRequests.id, requestId),
				eq(loomMigrationRequests.activeImportLeaseToken, token),
				gt(loomMigrationRequests.activeImportLeaseUntil, now),
				isNotNull(loomMigrationRequests.activeOrganizationId),
			),
		);
	if (result.meta.changes === 0) {
		throw new LoomMigrationError(
			"The concierge import expired. Refresh and retry.",
		);
	}
}

export async function getCustomerMigrationRequests(
	organizationId: Organisation.OrganisationId,
) {
	await requireCustomerMigrationAccess(organizationId);
	const requests = await db()
		.select()
		.from(loomMigrationRequests)
		.where(eq(loomMigrationRequests.organizationId, organizationId))
		.orderBy(desc(loomMigrationRequests.createdAt))
		.limit(20);
	return requests.map(migrationToView);
}

export async function getOperatorMigrationQueue() {
	await requireMigrationOperator();
	const queue = await db()
		.select({
			request: loomMigrationRequests,
			organizationName: organizations.name,
			requestedByEmail: users.email,
		})
		.from(loomMigrationRequests)
		.innerJoin(
			organizations,
			eq(organizations.id, loomMigrationRequests.organizationId),
		)
		.innerJoin(users, eq(users.id, loomMigrationRequests.requestedByUserId))
		.where(
			and(
				ne(loomMigrationRequests.status, "completed"),
				isNull(organizations.tombstoneAt),
			),
		)
		.orderBy(asc(loomMigrationRequests.createdAt));
	return queue.map((item) => ({
		...migrationToView(item.request),
		organizationName: item.organizationName,
		requestedByEmail: item.requestedByEmail,
	}));
}
