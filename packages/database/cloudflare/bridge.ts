import type {
	D1Database,
	D1DatabaseSession,
	D1ExecResult,
	D1PreparedStatement,
	D1Result,
} from "@cloudflare/workers-types";
import { z } from "zod";

const MAX_BODY_BYTES = 1024 * 1024;
const bytesSchema = z
	.object({
		type: z.literal("bytes"),
		value: z.array(z.number().int().min(0).max(255)).max(MAX_BODY_BYTES),
	})
	.strict();
const parameterSchema = z.union([
	z.string(),
	z.number().finite(),
	z.null(),
	bytesSchema,
]);
const statementSchema = z
	.object({
		sql: z.string().min(1).max(100_000),
		params: z.array(parameterSchema).max(100),
	})
	.strict();
const requestSchema = z.discriminatedUnion("operation", [
	z
		.object({
			operation: z.literal("statement"),
			statement: statementSchema,
			method: z.enum(["raw", "all", "run", "first"]),
			columnNames: z.boolean().optional(),
			columnName: z.string().optional(),
		})
		.strict(),
	z
		.object({
			operation: z.literal("batch"),
			statements: z.array(statementSchema).min(1).max(100),
		})
		.strict(),
]);
const resultSchema = z.object({
	success: z.literal(true),
	results: z.array(z.record(z.unknown())),
	meta: z
		.object({
			duration: z.number(),
			size_after: z.number(),
			rows_read: z.number(),
			rows_written: z.number(),
			last_row_id: z.number(),
			changed_db: z.boolean(),
			changes: z.number(),
		})
		.passthrough(),
});
const errorSchema = z.object({ error: z.string() });
type Statement = z.infer<typeof statementSchema>;
type BridgeRequest = z.infer<typeof requestSchema>;

function encodeParameter(value: unknown): z.infer<typeof parameterSchema> {
	if (value instanceof ArrayBuffer)
		return { type: "bytes", value: Array.from(new Uint8Array(value)) };
	if (ArrayBuffer.isView(value))
		return {
			type: "bytes",
			value: Array.from(
				new Uint8Array(value.buffer, value.byteOffset, value.byteLength),
			),
		};
	return parameterSchema.parse(value);
}

function prepare(
	database: D1Database,
	statement: Statement,
): D1PreparedStatement {
	return database
		.prepare(statement.sql)
		.bind(
			...statement.params.map((value) =>
				value !== null && typeof value === "object"
					? new Uint8Array(value.value)
					: value,
			),
		);
}

async function readBody(request: Request): Promise<unknown> {
	const reader = request.body?.getReader();
	if (!reader) throw new Error("Missing request body");
	const chunks: Uint8Array[] = [];
	let size = 0;
	for (;;) {
		const chunk = await reader.read();
		if (chunk.done) break;
		size += chunk.value.byteLength;
		if (size > MAX_BODY_BYTES) {
			await reader.cancel();
			throw new Error("Request exceeds bridge body limit");
		}
		chunks.push(chunk.value);
	}
	const body = new Uint8Array(size);
	let offset = 0;
	for (const chunk of chunks) {
		body.set(chunk, offset);
		offset += chunk.byteLength;
	}
	return JSON.parse(new TextDecoder().decode(body));
}

export async function handleD1BridgeRequest(
	request: Request,
	database: D1Database,
): Promise<Response> {
	if (request.method !== "POST")
		return Response.json(
			{ error: "Method not allowed" },
			{ status: 405, headers: { Allow: "POST" } },
		);
	let input: BridgeRequest;
	try {
		input = requestSchema.parse(await readBody(request));
	} catch {
		return Response.json(
			{ error: "Invalid D1 bridge request" },
			{ status: 400 },
		);
	}
	try {
		if (input.operation === "batch")
			return Response.json(
				await database.batch(
					input.statements.map((statement) => prepare(database, statement)),
				),
			);
		const statement = prepare(database, input.statement);
		if (input.method === "raw")
			return Response.json(
				input.columnNames
					? await statement.raw({ columnNames: true })
					: await statement.raw(),
			);
		if (input.method === "first")
			return Response.json(
				input.columnName
					? await statement.first(input.columnName)
					: await statement.first(),
			);
		return Response.json(await statement[input.method]());
	} catch (error) {
		return Response.json(
			{
				error:
					error instanceof Error
						? error.message.slice(0, 4000)
						: "D1 execution failed",
			},
			{ status: 500 },
		);
	}
}

export function createD1BridgeBinding(
	options: {
		url?: string;
		fetch?: (request: Request) => Promise<Response>;
	} = {},
): D1Database {
	const url = options.url ?? "http://cap.database/query";
	const fetcher = options.fetch ?? globalThis.fetch;
	const send = async (input: BridgeRequest): Promise<unknown> => {
		requestSchema.parse(input);
		const body = JSON.stringify(input);
		if (new TextEncoder().encode(body).byteLength > MAX_BODY_BYTES)
			throw new Error("Request exceeds bridge body limit");
		const response = await fetcher(
			new Request(url, {
				method: "POST",
				redirect: "error",
				headers: { "Content-Type": "application/json" },
				body,
				signal: AbortSignal.timeout(30_000),
			}),
		);
		const value: unknown = await response.json();
		if (!response.ok) throw new Error(errorSchema.parse(value).error);
		return value;
	};
	class Prepared implements D1PreparedStatement {
		readonly statement: Statement;
		constructor(statement: Statement) {
			this.statement = statement;
		}
		bind(...values: unknown[]): D1PreparedStatement {
			return new Prepared({
				sql: this.statement.sql,
				params: values.map(encodeParameter),
			});
		}
		async all<T = Record<string, unknown>>(): Promise<D1Result<T>> {
			return resultSchema.parse(
				await send({
					operation: "statement",
					statement: this.statement,
					method: "all",
				}),
			) as D1Result<T>;
		}
		async run<T = Record<string, unknown>>(): Promise<D1Result<T>> {
			return resultSchema.parse(
				await send({
					operation: "statement",
					statement: this.statement,
					method: "run",
				}),
			) as D1Result<T>;
		}
		async first<T = Record<string, unknown>>(
			columnName?: string,
		): Promise<T | null> {
			return (await send({
				operation: "statement",
				statement: this.statement,
				method: "first",
				columnName,
			})) as T | null;
		}
		raw<T = unknown[]>(options: {
			columnNames: true;
		}): Promise<[string[], ...T[]]>;
		raw<T = unknown[]>(options?: { columnNames?: false }): Promise<T[]>;
		async raw<T = unknown[]>(options?: {
			columnNames?: boolean;
		}): Promise<T[] | [string[], ...T[]]> {
			return z.array(z.array(z.unknown())).parse(
				await send({
					operation: "statement",
					statement: this.statement,
					method: "raw",
					columnNames: options?.columnNames,
				}),
			) as T[];
		}
	}
	return {
		prepare: (query) => new Prepared({ sql: query, params: [] }),
		batch: async <T = unknown>(
			statements: D1PreparedStatement[],
		): Promise<D1Result<T>[]> =>
			z.array(resultSchema).parse(
				await send({
					operation: "batch",
					statements: statements.map((statement) => {
						if (!(statement instanceof Prepared))
							throw new Error(
								"Cannot batch statements from another D1 binding",
							);
						return statement.statement;
					}),
				}),
			) as D1Result<T>[],
		exec: async (): Promise<D1ExecResult> => {
			throw new Error(
				"D1 bridge exec is disabled; migrations run outside the application.",
			);
		},
		dump: async (): Promise<ArrayBuffer> => {
			throw new Error(
				"D1 bridge dump is disabled; use controlled backup tooling.",
			);
		},
		withSession: (): D1DatabaseSession => {
			throw new Error(
				"D1 bridge sessions are unavailable; queries use the primary binding.",
			);
		},
	};
}
