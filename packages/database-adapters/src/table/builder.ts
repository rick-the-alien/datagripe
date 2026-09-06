import type { CellInput, TableColumn, TableSort } from "@datagripe/contracts";
import { type SplitOptions, splitStatements } from "@datagripe/sql-tools";

/**
 * Dialect-parameterised SQL for the table view (docs/spec/table-view.md).
 *
 * Every identifier that reaches these builders is either quoted or first
 * validated against the relation's real column list, and every value is
 * a bound parameter. The one raw fragment is the user's `where …`
 * filter, which is checked for statement stacking and only ever used on
 * the read path.
 */

export interface TableDialect {
	/** Quote one identifier for this dialect. */
	quote: (identifier: string) => string;
	/** Placeholder for the nth (1-based) bound parameter. */
	placeholder: (index: number) => string;
	/** Statement-splitting options, for the filter stacking check. */
	splitOptions: SplitOptions;
	/** Tail of an INSERT that supplies no columns at all. */
	defaultRow: string;
}

function doubleQuoted(identifier: string): string {
	return `"${identifier.replaceAll('"', '""')}"`;
}

export const POSTGRES_TABLE_DIALECT: TableDialect = {
	quote: doubleQuoted,
	placeholder: (index) => `$${index}`,
	splitOptions: {},
	defaultRow: "DEFAULT VALUES",
};

export const MYSQL_TABLE_DIALECT: TableDialect = {
	quote: (identifier) => `\`${identifier.replaceAll("`", "``")}\``,
	placeholder: () => "?",
	splitOptions: { backslashEscapes: true, backtickIdentifiers: true },
	// MySQL has no DEFAULT VALUES; the empty column list is its spelling.
	defaultRow: "() VALUES ()",
};

export const SQLITE_TABLE_DIALECT: TableDialect = {
	quote: doubleQuoted,
	placeholder: () => "?",
	splitOptions: { backtickIdentifiers: true },
	defaultRow: "DEFAULT VALUES",
};

/** Rejected filter / edit — surfaced to the client as a bad request. */
export class TableRequestError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "TableRequestError";
	}
}

/**
 * A `where …` fragment may be any expression, but it must stay one
 * statement: without this check the filter box is a second, unaudited
 * execution path that even a viewer can reach.
 */
export function assertSingleExpression(
	filter: string,
	dialect: TableDialect,
): void {
	const trimmed = filter.trim();
	const statements = splitStatements(trimmed, dialect.splitOptions);
	// Quote-aware, so a semicolon inside a string literal is fine. What is
	// not fine is a top-level one: either it produced a second statement,
	// or it trails the first and would truncate the query we build around
	// the filter.
	const only = statements[0];
	if (
		statements.length > 1 ||
		only === undefined ||
		only.end !== trimmed.length
	) {
		throw new TableRequestError(
			"The filter must be a single expression without ';'",
		);
	}
}

export function qualify(
	dialect: TableDialect,
	schema: string,
	table: string,
): string {
	return `${dialect.quote(schema)}.${dialect.quote(table)}`;
}

/** ORDER BY over columns that exist, so the clause can be built by name. */
export function orderByClause(
	dialect: TableDialect,
	sort: TableSort[],
	columns: TableColumn[],
): string {
	if (sort.length === 0) {
		return "";
	}
	const known = new Set(columns.map((column) => column.name));
	const terms = sort.map((term) => {
		if (!known.has(term.column)) {
			throw new TableRequestError(`Unknown sort column '${term.column}'`);
		}
		return `${dialect.quote(term.column)} ${
			term.direction === "desc" ? "DESC" : "ASC"
		}`;
	});
	return ` ORDER BY ${terms.join(", ")}`;
}

export interface PageQuery {
	sql: string;
	params: unknown[];
}

export function selectPage(
	dialect: TableDialect,
	options: {
		schema: string;
		table: string;
		columns: TableColumn[];
		sort: TableSort[];
		filter: string;
		limit: number;
		offset: number;
	},
): PageQuery {
	const filter = options.filter.trim();
	if (filter !== "") {
		assertSingleExpression(filter, dialect);
	}
	const projection = options.columns
		.map((column) => dialect.quote(column.name))
		.join(", ");
	const where = filter === "" ? "" : ` WHERE ${filter}`;
	const order = orderByClause(dialect, options.sort, options.columns);
	// Integers from a validated request — never user text.
	const paging = ` LIMIT ${Math.trunc(options.limit)} OFFSET ${Math.trunc(
		options.offset,
	)}`;
	return {
		sql: `SELECT ${projection === "" ? "*" : projection} FROM ${qualify(
			dialect,
			options.schema,
			options.table,
		)}${where}${order}${paging}`,
		params: [],
	};
}

export function selectCount(
	dialect: TableDialect,
	options: { schema: string; table: string; filter: string },
): PageQuery {
	const filter = options.filter.trim();
	if (filter !== "") {
		assertSingleExpression(filter, dialect);
	}
	const where = filter === "" ? "" : ` WHERE ${filter}`;
	return {
		sql: `SELECT count(*) AS dg_total FROM ${qualify(
			dialect,
			options.schema,
			options.table,
		)}${where}`,
		params: [],
	};
}

/** Parameter accumulator so `$n` placeholders stay in bind order. */
class Binder {
	readonly params: unknown[] = [];

	constructor(private readonly dialect: TableDialect) {}

	bind(value: unknown): string {
		this.params.push(value);
		return this.dialect.placeholder(this.params.length);
	}
}

function inputValue(input: CellInput): string | null {
	return input.kind === "null" ? null : input.kind === "text" ? input.text : "";
}

/**
 * `key = value` terms for a row's primary key. A null key value becomes
 * `IS NULL`, which never matches in SQL for a real PK but keeps the
 * generated statement valid rather than silently matching everything.
 */
function keyPredicate(
	dialect: TableDialect,
	binder: Binder,
	key: Record<string, CellInput>,
	keyColumns: string[],
): string {
	return keyColumns
		.map((name) => {
			const input = key[name];
			if (input === undefined) {
				throw new TableRequestError(`Missing key column '${name}'`);
			}
			if (input.kind === "null") {
				return `${dialect.quote(name)} IS NULL`;
			}
			if (input.kind === "default") {
				throw new TableRequestError(`Key column '${name}' cannot be a default`);
			}
			return `${dialect.quote(name)} = ${binder.bind(input.text)}`;
		})
		.join(" AND ");
}

export interface WritableRelation {
	schema: string;
	table: string;
	columns: TableColumn[];
	/** Primary key column names, in ordinal order. */
	keyColumns: string[];
}

/** Column names the client is allowed to write. */
function assertWritableColumns(
	relation: WritableRelation,
	values: Record<string, CellInput>,
): string[] {
	const byName = new Map(
		relation.columns.map((column) => [column.name, column]),
	);
	const names = Object.keys(values);
	for (const name of names) {
		const column = byName.get(name);
		if (column === undefined) {
			throw new TableRequestError(`Unknown column '${name}'`);
		}
		if (column.generated) {
			throw new TableRequestError(
				`Column '${name}' is generated and cannot be written`,
			);
		}
	}
	// Emit in ordinal order so the generated SQL is stable and testable.
	return relation.columns
		.map((column) => column.name)
		.filter((name) => names.includes(name));
}

function assertExactKey(
	relation: WritableRelation,
	key: Record<string, CellInput>,
): void {
	const provided = Object.keys(key).sort();
	const expected = [...relation.keyColumns].sort();
	if (
		provided.length !== expected.length ||
		provided.some((name, index) => name !== expected[index])
	) {
		throw new TableRequestError(
			`Row identity must be exactly the primary key (${expected.join(", ")})`,
		);
	}
}

export function updateStatement(
	dialect: TableDialect,
	relation: WritableRelation,
	edit: { key: Record<string, CellInput>; values: Record<string, CellInput> },
): PageQuery {
	assertExactKey(relation, edit.key);
	const names = assertWritableColumns(relation, edit.values);
	if (names.length === 0) {
		throw new TableRequestError("An update needs at least one column");
	}
	const binder = new Binder(dialect);
	const assignments = names.map((name) => {
		const input = edit.values[name] as CellInput;
		if (input.kind === "default") {
			return `${dialect.quote(name)} = DEFAULT`;
		}
		return `${dialect.quote(name)} = ${binder.bind(inputValue(input))}`;
	});
	const where = keyPredicate(dialect, binder, edit.key, relation.keyColumns);
	return {
		sql: `UPDATE ${qualify(dialect, relation.schema, relation.table)} SET ${assignments.join(
			", ",
		)} WHERE ${where}`,
		params: binder.params,
	};
}

export function insertStatement(
	dialect: TableDialect,
	relation: WritableRelation,
	edit: { values: Record<string, CellInput> },
): PageQuery {
	// "default" means "leave the column out and let the database decide",
	// which is exactly what an omitted column already does.
	const explicit = Object.fromEntries(
		Object.entries(edit.values).filter(([, input]) => input.kind !== "default"),
	);
	const names = assertWritableColumns(relation, explicit);
	const target = qualify(dialect, relation.schema, relation.table);
	if (names.length === 0) {
		return { sql: `INSERT INTO ${target} ${dialect.defaultRow}`, params: [] };
	}
	const binder = new Binder(dialect);
	const placeholders = names.map((name) =>
		binder.bind(inputValue(explicit[name] as CellInput)),
	);
	return {
		sql: `INSERT INTO ${target} (${names
			.map((name) => dialect.quote(name))
			.join(", ")}) VALUES (${placeholders.join(", ")})`,
		params: binder.params,
	};
}

export function deleteStatement(
	dialect: TableDialect,
	relation: WritableRelation,
	edit: { key: Record<string, CellInput> },
): PageQuery {
	assertExactKey(relation, edit.key);
	const binder = new Binder(dialect);
	const where = keyPredicate(dialect, binder, edit.key, relation.keyColumns);
	return {
		sql: `DELETE FROM ${qualify(
			dialect,
			relation.schema,
			relation.table,
		)} WHERE ${where}`,
		params: binder.params,
	};
}

/**
 * Why a relation cannot be edited, or null when it can. A table without
 * a primary key is browsable but not writable: there is no predicate
 * that provably touches one row.
 */
export function editabilityReason(options: {
	kind: "table" | "view";
	readOnly: boolean;
	keyColumns: string[];
}): string | null {
	if (options.readOnly) {
		return "This datasource is read-only";
	}
	if (options.kind === "view") {
		return "Views cannot be edited in the grid";
	}
	if (options.keyColumns.length === 0) {
		return "This table has no primary key, so a row cannot be addressed";
	}
	return null;
}

/**
 * MySQL and SQLite have no `SET col = DEFAULT` on every column, and
 * "default" on update is ambiguous anyway — reject it early rather than
 * emitting SQL that only some engines accept.
 */
export function assertNoUpdateDefaults(
	values: Record<string, CellInput>,
): void {
	for (const [name, input] of Object.entries(values)) {
		if (input.kind === "default") {
			throw new TableRequestError(
				`Column '${name}' cannot be set to DEFAULT by this datasource`,
			);
		}
	}
}
