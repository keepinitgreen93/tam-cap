import { eq, sql } from "drizzle-orm";
import type { BatchItem } from "drizzle-orm/batch";
import { databaseRevision, snapshotGuard } from "./concurrency-schema.ts";
import type { CloudflareDatabase } from "./index.ts";

export type AtomicStatement = BatchItem<"sqlite">;
export type SnapshotReader = Pick<
	CloudflareDatabase,
	"select" | "selectDistinct" | "query"
>;
export type AtomicSnapshot = {
	read: <T>(read: (database: SnapshotReader) => PromiseLike<T>) => Promise<T>;
};
export type AtomicPlan<T> = {
	statements: readonly AtomicStatement[];
	result: T;
};

export class AtomicConflictError extends Error {
	constructor() {
		super("The database changed during this operation. Retry the request.");
		this.name = "AtomicConflictError";
	}
}

export function isSnapshotConflict(error: unknown): boolean {
	const visited = new Set<unknown>();
	let current = error;
	while (current instanceof Error && !visited.has(current)) {
		visited.add(current);
		if (
			current.message.includes("CHECK constraint failed: cap_d1_snapshot_guard")
		)
			return true;
		current = current.cause;
	}
	return false;
}

async function revision(database: CloudflareDatabase): Promise<number> {
	const [row] = await database
		.select({ revision: databaseRevision.revision })
		.from(databaseRevision)
		.where(eq(databaseRevision.id, 1));
	if (!row || !Number.isSafeInteger(row.revision) || row.revision < 0)
		throw new Error("D1 concurrency migration is missing or invalid.");
	return row.revision;
}

export function atomic<TPlan extends AtomicPlan<unknown>>(
	database: CloudflareDatabase,
	plan: (snapshot: AtomicSnapshot) => Promise<TPlan>,
	options?: { maxAttempts?: number },
): Promise<TPlan["result"]>;
export function atomic<T>(
	database: CloudflareDatabase,
	plan: (snapshot: AtomicSnapshot) => Promise<AtomicPlan<T>>,
	options?: { maxAttempts?: number },
): Promise<T>;
export async function atomic<T>(
	database: CloudflareDatabase,
	plan: (snapshot: AtomicSnapshot) => Promise<AtomicPlan<T>>,
	options: { maxAttempts?: number } = {},
): Promise<T> {
	const maxAttempts = options.maxAttempts ?? 8;
	if (!Number.isInteger(maxAttempts) || maxAttempts < 1 || maxAttempts > 50)
		throw new Error("Atomic maxAttempts must be an integer between 1 and 50.");
	const reader: SnapshotReader = {
		select: database.select.bind(database),
		selectDistinct: database.selectDistinct.bind(database),
		query: database.query,
	};
	for (let attempt = 0; attempt < maxAttempts; attempt++) {
		const expected = await revision(database);
		let planned: AtomicPlan<T> | undefined;
		let planningError: unknown;
		let planningFailed = false;
		try {
			planned = await plan({ read: async (read) => read(reader) });
		} catch (error) {
			planningError = error;
			planningFailed = true;
		}
		if ((await revision(database)) === expected) {
			if (planningFailed) throw planningError;
			if (!planned) throw new Error("Atomic planner returned no plan.");
			if (planned.statements.length > 48)
				throw new Error(
					"Atomic plan exceeds the 48-statement bridge limit. Use bounded set-based operations.",
				);
			try {
				await database.batch([
					database.insert(snapshotGuard).values({
						id: 1,
						valid: sql`coalesce((select ${databaseRevision.revision} = ${expected} from ${databaseRevision} where ${databaseRevision.id} = 1), 0)`,
					}),
					database.delete(snapshotGuard).where(eq(snapshotGuard.id, 1)),
					...planned.statements,
				]);
				return planned.result;
			} catch (error) {
				if (!isSnapshotConflict(error)) throw error;
			}
		}
		if (attempt + 1 < maxAttempts)
			await new Promise((resolve) =>
				setTimeout(
					resolve,
					Math.min(5 * 2 ** attempt, 100) + Math.floor(Math.random() * 10),
				),
			);
	}
	throw new AtomicConflictError();
}
