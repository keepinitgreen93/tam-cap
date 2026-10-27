import type { CloudflareDatabase } from "@cap/database/cloudflare";
import type { SQL } from "drizzle-orm";
import { QueryPromise } from "drizzle-orm/query-promise";
import { SQLiteSyncDialect } from "drizzle-orm/sqlite-core";
import {
	databaseRevision,
	snapshotGuard,
} from "../../../../packages/database/cloudflare/concurrency-schema";

export type ModelRow = Record<string, unknown>;
export type ModelMutation = {
	table: unknown;
	operation: "insert" | "update" | "delete";
	values: ModelRow | ModelRow[];
	condition?: SQL;
	conflict?: ModelRow;
};
export function createRecordingD1Model(options: {
	read: (input: {
		table: unknown;
		fields?: unknown;
		condition?: SQL;
		joins: unknown[];
		maximum: number;
	}) => ModelRow[] | Promise<ModelRow[]>;
	apply: (
		statements: readonly ModelMutation[],
	) => void | number[] | Promise<void> | Promise<number[]>;
	signature?: () => string;
	beforeCommit?: () => void | Promise<void>;
}) {
	let counter = 0;
	let signature = "";
	let tail = Promise.resolve();
	const revision = () => {
		if (!options.signature) return counter;
		const current = options.signature();
		if (current !== signature) {
			signature = current;
			counter++;
		}
		return counter;
	};
	class Selection extends QueryPromise<ModelRow[]> {
		private table: unknown;
		private condition: SQL | undefined;
		private maximum = Number.POSITIVE_INFINITY;
		private joins: unknown[] = [];
		constructor(private fields?: unknown) {
			super();
		}
		from(table: unknown) {
			this.table = table;
			return this;
		}
		where(condition: SQL) {
			this.condition = condition;
			return this;
		}
		limit(maximum: number) {
			this.maximum = maximum;
			return this;
		}
		orderBy() {
			return this;
		}
		innerJoin(table: unknown) {
			this.joins.push(table);
			return this;
		}
		leftJoin(table: unknown) {
			this.joins.push(table);
			return this;
		}
		async execute() {
			if (this.table === databaseRevision) return [{ revision: revision() }];
			return (
				await options.read({
					table: this.table,
					fields: this.fields,
					condition: this.condition,
					joins: this.joins,
					maximum: this.maximum,
				})
			).slice(0, this.maximum);
		}
	}
	class Mutation
		extends QueryPromise<{ meta: { changes: number } }>
		implements ModelMutation
	{
		condition: SQL | undefined;
		conflict: ModelRow | undefined;
		constructor(
			readonly table: unknown,
			readonly operation: ModelMutation["operation"],
			readonly values: ModelRow | ModelRow[] = {},
		) {
			super();
		}
		where(condition: SQL) {
			this.condition = condition;
			return this;
		}
		onConflictDoUpdate({ set }: { set: ModelRow }) {
			this.conflict = set;
			return this;
		}
		async execute() {
			return (await batch([this]))[0] ?? { meta: { changes: 0 } };
		}
	}
	async function batch(statements: Mutation[]) {
		const previous = tail;
		let release = () => {};
		tail = new Promise<void>((resolve) => {
			release = resolve;
		});
		await previous;
		try {
			await options.beforeCommit?.();
			const guard = statements.find(
				(statement) =>
					statement.table === snapshotGuard && statement.operation === "insert",
			);
			if (guard && !Array.isArray(guard.values)) {
				const expected = new SQLiteSyncDialect().sqlToQuery(
					guard.values.valid as SQL,
				).params[0];
				if (expected !== revision())
					throw new Error("CHECK constraint failed: cap_d1_snapshot_guard");
			}
			const mutations = statements.filter(
				(statement) => statement.table !== snapshotGuard,
			);
			const counts = await options.apply(mutations);
			if (mutations.length) counter++;
			let index = 0;
			return statements.map((statement) => ({
				meta: {
					changes:
						statement.table === snapshotGuard
							? 1
							: Array.isArray(counts)
								? (counts[index++] ?? 1)
								: 1,
				},
			}));
		} finally {
			release();
		}
	}
	return {
		select: (fields?: unknown) => new Selection(fields),
		selectDistinct: (fields?: unknown) => new Selection(fields),
		query: {},
		insert: (table: unknown) => ({
			values: (values: ModelRow | ModelRow[]) =>
				new Mutation(table, "insert", values),
		}),
		update: (table: unknown) => ({
			set: (values: ModelRow) => new Mutation(table, "update", values),
		}),
		delete: (table: unknown) => new Mutation(table, "delete"),
		batch,
	} as unknown as CloudflareDatabase;
}
