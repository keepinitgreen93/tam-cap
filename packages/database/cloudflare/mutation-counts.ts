import type {
	D1Database,
	D1PreparedStatement,
	D1Result,
} from "@cloudflare/workers-types";

export function withExactMutationCounts(database: D1Database): D1Database {
	const countStatement = () =>
		database.prepare("SELECT changes() AS cap_statement_changes");
	const normalize = <T>(
		result: D1Result<T> | undefined,
		count: D1Result | undefined,
	): D1Result<T> => {
		const row = count?.results[0];
		if (
			!result ||
			!row ||
			typeof row !== "object" ||
			!("cap_statement_changes" in row) ||
			!Number.isSafeInteger(row.cap_statement_changes)
		)
			throw new Error("D1 returned an invalid mutation count.");
		return {
			...result,
			meta: { ...result.meta, changes: row.cap_statement_changes as number },
		};
	};
	class Prepared implements D1PreparedStatement {
		readonly statement: D1PreparedStatement;
		constructor(statement: D1PreparedStatement) {
			this.statement = statement;
		}
		bind(...values: unknown[]): D1PreparedStatement {
			return new Prepared(this.statement.bind(...values));
		}
		async all<T = Record<string, unknown>>(): Promise<D1Result<T>> {
			const [result, count] = await database.batch<T>([
				this.statement,
				countStatement(),
			]);
			return normalize(result, count);
		}
		async run<T = Record<string, unknown>>(): Promise<D1Result<T>> {
			return this.all<T>();
		}
		first<T = Record<string, unknown>>(columnName?: string): Promise<T | null> {
			return columnName === undefined
				? this.statement.first<T>()
				: this.statement.first<T>(columnName);
		}
		raw<T = unknown[]>(options: {
			columnNames: true;
		}): Promise<[string[], ...T[]]>;
		raw<T = unknown[]>(options?: { columnNames?: false }): Promise<T[]>;
		raw<T = unknown[]>(options?: {
			columnNames?: boolean;
		}): Promise<T[] | [string[], ...T[]]> {
			return options?.columnNames
				? this.statement.raw<T>({ columnNames: true })
				: this.statement.raw<T>();
		}
	}
	return {
		prepare: (query) => new Prepared(database.prepare(query)),
		batch: async <T = unknown>(
			statements: D1PreparedStatement[],
		): Promise<D1Result<T>[]> => {
			const expanded = statements.flatMap((statement) => {
				if (!(statement instanceof Prepared))
					throw new Error("Cannot batch statements from another D1 binding");
				return [statement.statement, countStatement()];
			});
			const results = await database.batch<T>(expanded);
			return statements.map((_, index) =>
				normalize(results[index * 2], results[index * 2 + 1]),
			);
		},
		exec: (query) => database.exec(query),
		dump: () => database.dump(),
		withSession: (constraint) => database.withSession(constraint),
	};
}
