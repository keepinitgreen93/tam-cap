import { readFile } from "node:fs/promises";
import { z } from "zod";

const columnSchema = z.object({ name: z.string(), type: z.string() });
const snapshotSchema = z.object({
	tables: z.record(
		z.object({ name: z.string(), columns: z.record(columnSchema) }),
	),
});
export type ValidationColumn = z.infer<typeof columnSchema>;
export type ValidationTable = { name: string; columns: ValidationColumn[] };

export async function readValidationContract(): Promise<ValidationTable[]> {
	const snapshot = snapshotSchema.parse(
		JSON.parse(
			await readFile(
				new URL("../migrations/meta/0051_snapshot.json", import.meta.url),
				"utf8",
			),
		),
	);
	return Object.entries(snapshot.tables)
		.sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
		.map(([key, table]) => {
			if (key !== table.name)
				throw new Error("MySQL snapshot table name mismatch");
			return { name: table.name, columns: Object.values(table.columns) };
		});
}

const identifier = (value: string) => `"${value.replaceAll('"', '""')}"`;
const literal = (value: string) => `'${value.replaceAll("'", "''")}'`;

function characterLimit(value: string, limit: number): string {
	return `(CASE WHEN instr(${value}, char(0)) = 0 THEN length(${value}) <= ${limit} WHEN length(CAST(${value} AS BLOB)) > ${limit * 4} THEN 0 ELSE (WITH RECURSIVE cap_value(encoded, bytes) AS MATERIALIZED (SELECT hex(CAST(${value} AS BLOB)), length(CAST(${value} AS BLOB))), cap_positions(position) AS (SELECT 1 UNION ALL SELECT position + 2 FROM cap_positions, cap_value WHERE position + 2 <= bytes * 2) SELECT count(*) FROM cap_positions, cap_value WHERE substr(encoded, position, 2) NOT BETWEEN '80' AND 'BF') <= ${limit} END)`;
}

export function columnValidity(
	column: ValidationColumn,
	value: string,
): string {
	const type = column.type.toLowerCase();
	const varchar = /^varchar\((\d+)\)$/.exec(type);
	if (varchar)
		return `typeof(${value}) = 'text' AND ${characterLimit(value, Number(varchar[1]))}`;
	if (type === "text" || type === "longtext")
		return `typeof(${value}) = 'text' AND length(CAST(${value} AS BLOB)) <= ${type === "text" ? 65_535 : 4_294_967_295}`;
	if (type === "json")
		return `typeof(${value}) = 'text' AND json_valid(${value})`;
	if (type === "boolean")
		return `typeof(${value}) = 'integer' AND ${value} IN (0, 1)`;
	if (type === "int" || type === "int unsigned")
		return `typeof(${value}) = 'integer' AND ${value} BETWEEN ${type.endsWith("unsigned") ? 0 : -2_147_483_648} AND ${type.endsWith("unsigned") ? 4_294_967_295 : 2_147_483_647}`;
	if (type === "bigint" || type === "bigint unsigned")
		return `typeof(${value}) = 'integer' AND ${value} BETWEEN ${type.endsWith("unsigned") ? 0 : -Number.MAX_SAFE_INTEGER} AND ${Number.MAX_SAFE_INTEGER}`;
	if (type === "float")
		return `typeof(${value}) IN ('integer', 'real') AND ${value} BETWEEN -3.4028234663852886e38 AND 3.4028234663852886e38`;
	if (/^(?:timestamp|datetime)(?:\(\d+\))?$/.test(type))
		return `typeof(${value}) = 'integer' AND ${value} BETWEEN -8640000000000000 AND 8640000000000000`;
	throw new Error(
		`Unsupported source SQL type ${column.type} for ${column.name}`,
	);
}

export function buildValidationMigration(tables: ValidationTable[]): string {
	const statements = tables.flatMap((table) =>
		["INSERT", "UPDATE"].map((operation) => {
			const checks = table.columns.map((column) => {
				const value = `NEW.${identifier(column.name)}`;
				return `SELECT RAISE(ABORT, ${literal(`CHECK constraint failed: cap_validate_${table.name}_${column.name}`)}) WHERE ${value} IS NOT NULL AND NOT (${columnValidity(column, value)});`;
			});
			return `CREATE TRIGGER ${identifier(`cap_validate_${table.name}_${operation.toLowerCase()}`)} BEFORE ${operation} ON ${identifier(table.name)} BEGIN\n${checks.join("\n")}\nEND`;
		}),
	);
	return `${statements.join(";\n--> statement-breakpoint\n")};\n`;
}

export function buildValidationPreflight(tables: ValidationTable[]): string {
	return `${tables
		.map((table) => {
			const invalid = table.columns.map((column) => {
				const value = identifier(column.name);
				return `(${value} IS NOT NULL AND NOT (${columnValidity(column, value)}))`;
			});
			return `SELECT ${literal(table.name)} AS table_name, count(*) AS invalid_rows FROM ${identifier(table.name)} WHERE ${invalid.join(" OR ")}`;
		})
		.join(";\n")}\n;\n`;
}
