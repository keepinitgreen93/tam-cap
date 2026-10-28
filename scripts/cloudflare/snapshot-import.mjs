import { DatabaseSync } from "node:sqlite";

const identifier = (name) => `"${name.replaceAll('"', '""')}"`;
export function snapshotLiteral(value) {
	if (value === null) return "NULL";
	if (typeof value === "string")
		return `CAST(X'${Buffer.from(value, "utf8").toString("hex")}' AS TEXT)`;
	if (value instanceof Uint8Array)
		return `X'${Buffer.from(value).toString("hex")}'`;
	if (typeof value === "bigint") return value.toString();
	if (typeof value === "number" && Number.isFinite(value)) return String(value);
	throw Error("Snapshot contains an unsupported SQLite value");
}
export function projectSnapshot(sql) {
	const database = new DatabaseSync(":memory:", {
		enableForeignKeyConstraints: false,
	});
	try {
		database.exec(sql);
		if (database.prepare("PRAGMA foreign_key_check").all().length)
			throw Error("Snapshot foreign key integrity failed");
		const schema = database
			.prepare(
				"SELECT type,name,sql FROM sqlite_master WHERE name NOT LIKE 'sqlite_%' AND name NOT LIKE '_cf_%' AND sql IS NOT NULL ORDER BY type,name",
			)
			.all();
		if (
			schema.some(
				(row) => !["table", "index", "view", "trigger"].includes(row.type),
			)
		)
			throw Error("Unsupported snapshot schema object");
		const tables = schema.filter((row) => row.type === "table");
		const data = new Map(
			tables.map((table) => {
				const columns = database
					.prepare(`PRAGMA table_xinfo(${identifier(table.name)})`)
					.all()
					.filter((column) => column.hidden === 0)
					.map((column) => column.name);
				const rows = database
					.prepare(
						`SELECT ${columns.map(identifier).join(",")} FROM ${identifier(table.name)}`,
					)
					.all();
				const dependencies = database
					.prepare(`PRAGMA foreign_key_list(${identifier(table.name)})`)
					.all()
					.filter((key) => rows.some((row) => row[key.from] !== null))
					.map((key) => key.table);
				return [table.name, { columns, rows, dependencies }];
			}),
		);
		const ordered = [];
		const visited = new Set();
		const visiting = new Set();
		const visit = (name) => {
			if (visited.has(name)) return;
			if (visiting.has(name))
				throw Error(
					"Cyclic snapshot data dependencies require a transactional restore path",
				);
			const table = data.get(name);
			if (!table) throw Error("Snapshot references an unknown table");
			visiting.add(name);
			for (const dependency of table.dependencies) visit(dependency);
			visiting.delete(name);
			visited.add(name);
			ordered.push(name);
		};
		for (const table of tables) visit(table.name);
		const statements = tables.map((row) => `${row.sql};`);
		for (const name of ordered) {
			const { columns, rows } = data.get(name);
			for (const row of rows)
				statements.push(
					`INSERT INTO ${identifier(name)} (${columns.map(identifier).join(",")}) VALUES (${columns.map((column) => snapshotLiteral(row[column])).join(",")});`,
				);
		}
		if (
			database
				.prepare("SELECT 1 FROM sqlite_master WHERE name='sqlite_sequence'")
				.get()
		) {
			statements.push("DELETE FROM sqlite_sequence;");
			for (const row of database
				.prepare("SELECT name,seq FROM sqlite_sequence")
				.all())
				statements.push(
					`INSERT INTO sqlite_sequence(name,seq) VALUES(${snapshotLiteral(row.name)},${snapshotLiteral(row.seq)});`,
				);
		}
		for (const type of ["index", "view", "trigger"])
			for (const row of schema.filter((row) => row.type === type))
				statements.push(`${row.sql};`);
		return { statements, sql: statements.join("\n") };
	} finally {
		database.close();
	}
}
export function schemaBeforeData(sql) {
	return projectSnapshot(sql).sql;
}
