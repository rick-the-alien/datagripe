import type {
	ObjectColumn,
	ObjectConstraint,
	ObjectDependent,
	ObjectDescribeResult,
	ObjectIndex,
	ObjectTab,
	ObjectTrigger,
} from "@datagripe/contracts";
import { isRelationKind, tabsForKind } from "@datagripe/contracts";
import type { SQL } from "bun";
import { formatBytes, formatCount, statTiles } from "../object/format";
import { TableRequestError } from "../table/builder";
import type { ObjectRequest } from "../types";

/**
 * SQLite object view (docs/spec/object-view.md). Everything comes from
 * PRAGMAs and `sqlite_master`, which take no bind parameters — the
 * schema and object names are quoted into them, the same defensive
 * quoting the introspection path already uses.
 *
 * SQLite has no permission system, so the grants tab is reported
 * unsupported rather than shown empty.
 */

const UNSUPPORTED: ObjectTab[] = ["grants"];

type Row = Record<string, unknown>;

function quoted(identifier: string): string {
	return `"${identifier.replaceAll('"', '""')}"`;
}

function literal(value: string): string {
	return `'${value.replaceAll("'", "''")}'`;
}

function text(value: unknown): string {
	return value === null || value === undefined ? "" : String(value);
}

function nullableText(value: unknown): string | null {
	return value === null || value === undefined ? null : String(value);
}

/**
 * SQLite stores a trigger as its original CREATE text, so timing and
 * events have to be read back out of it. A trigger whose header does not
 * parse still lists — with its SQL as the action — rather than vanishing.
 */
export function parseTriggerHeader(sql: string): {
	timing: string;
	events: string;
} {
	const header = sql.slice(0, 400).toLowerCase();
	const timing = /\binstead\s+of\b/.test(header)
		? "instead of"
		: /\bbefore\b/.test(header)
			? "before"
			: /\bafter\b/.test(header)
				? "after"
				: "";
	const events: string[] = [];
	if (/\binsert\s+on\b|\binsert\b(?=[\s\S]{0,40}\bon\b)/.test(header)) {
		events.push("insert");
	}
	if (/\bdelete\b(?=[\s\S]{0,40}\bon\b)/.test(header)) {
		events.push("delete");
	}
	if (/\bupdate\b(?=[\s\S]{0,60}\bon\b)/.test(header)) {
		events.push("update");
	}
	return { timing, events: events.join(", ") };
}

export async function describeSqliteObject(
	client: SQL,
	request: ObjectRequest,
): Promise<ObjectDescribeResult> {
	const query = async (sql: string, params: unknown[] = []): Promise<Row[]> =>
		(await client.unsafe(sql, params)) as Row[];

	if (!isRelationKind(request.kind)) {
		// SQLite has no stored routines and no sequences, so the tree never
		// offers one to describe.
		throw new TableRequestError(`SQLite has no '${request.kind}' objects`);
	}
	const relationKind = request.kind;

	const schema = quoted(request.schema);
	const target = quoted(request.name);

	const columnRows = await query(`PRAGMA ${schema}.table_xinfo(${target})`);
	const visible = columnRows.filter((row) => Number(row.hidden ?? 0) !== 1);
	if (visible.length === 0) {
		throw new TableRequestError(
			`'${request.schema}.${request.name}' was not found`,
		);
	}

	const columns: ObjectColumn[] = visible.map((row) => ({
		name: text(row.name),
		dataType: text(row.type) || "unknown",
		nullable: Number(row.notnull) === 0,
		defaultExpr: nullableText(row.dflt_value),
		primaryKey: Number(row.pk) > 0,
		// SQLite has no column comments.
		comment: null,
	}));

	const indexRows = await query(`PRAGMA ${schema}.index_list(${target})`);
	const indexes: ObjectIndex[] = [];
	for (const row of indexRows) {
		const name = text(row.name);
		const info = await query(`PRAGMA ${schema}.index_info(${quoted(name)})`);
		indexes.push({
			name,
			// SQLite has exactly one index method.
			method: "btree",
			columns: info
				.map((entry) => text(entry.name))
				.filter((entry) => entry !== "")
				.join(", "),
			unique: Number(row.unique) === 1,
			// origin 'pk' means the index backs the declared primary key.
			primary: text(row.origin) === "pk",
			sizeBytes: null,
		});
	}

	const constraints: ObjectConstraint[] = [];
	const keyColumns = columns
		.filter((column) => column.primaryKey)
		.map((column) => column.name);
	if (keyColumns.length > 0) {
		constraints.push({
			name: `${request.name}_pk`,
			type: "primary key",
			definition: `primary key (${keyColumns.join(", ")})`,
		});
	}
	for (const index of indexes) {
		if (index.unique && !index.primary) {
			constraints.push({
				name: index.name,
				type: "unique",
				definition: `unique (${index.columns})`,
			});
		}
	}
	const foreignKeys = await query(
		`PRAGMA ${schema}.foreign_key_list(${target})`,
	);
	for (const row of foreignKeys) {
		constraints.push({
			name: `fk_${text(row.id)}`,
			type: "foreign key",
			definition: `foreign key (${text(row.from)}) references ${text(
				row.table,
			)} (${text(row.to)})`,
		});
	}

	const triggerRows = await query(
		`SELECT name, sql FROM ${schema}.sqlite_master
		 WHERE type = 'trigger' AND tbl_name = ${literal(request.name)}
		 ORDER BY name`,
	);
	const triggers: ObjectTrigger[] = triggerRows.map((row) => {
		const sql = text(row.sql);
		const header = parseTriggerHeader(sql);
		return {
			name: text(row.name),
			timing: header.timing,
			events: header.events,
			action: sql,
			// SQLite triggers cannot be disabled.
			enabled: true,
		};
	});

	const ddlRows = await query(
		`SELECT sql FROM ${schema}.sqlite_master
		 WHERE name = ${literal(request.name)}`,
	);
	const ddl = nullableText(ddlRows[0]?.sql);

	const countRows = await query(
		`SELECT count(*) AS n FROM ${schema}.${target}`,
	);
	const rowCount = Number(countRows[0]?.n);
	const rowEstimate = Number.isFinite(rowCount) ? rowCount : null;

	const pageRows = await query(
		`SELECT (SELECT * FROM ${schema}.pragma_page_count()) AS pages,
			(SELECT * FROM ${schema}.pragma_page_size()) AS page_size`,
	).catch(() => [] as Row[]);
	const pages = Number(pageRows[0]?.pages);
	const pageSize = Number(pageRows[0]?.page_size);
	const fileBytes =
		Number.isFinite(pages) && Number.isFinite(pageSize)
			? pages * pageSize
			: null;

	const statistics = statTiles([
		["rows", formatCount(rowEstimate)],
		["columns", formatCount(columns.length)],
		["indexes", formatCount(indexes.length)],
		["triggers", formatCount(triggers.length)],
		// SQLite has no per-table size; the file is the honest unit.
		["database file", formatBytes(fileBytes)],
	]);

	// Only tables whose stored DDL mentions REFERENCES can depend on this
	// one, so the pragma runs over that shortlist instead of every table.
	const candidates = await query(
		`SELECT name FROM ${schema}.sqlite_master
		 WHERE type = 'table' AND sql LIKE '%REFERENCES%'
			 AND name <> ${literal(request.name)}`,
	);
	const dependents: ObjectDependent[] = [];
	if (relationKind === "table") {
		for (const candidate of candidates) {
			const child = text(candidate.name);
			const keys = await query(
				`PRAGMA ${schema}.foreign_key_list(${quoted(child)})`,
			);
			if (keys.some((key) => text(key.table) === request.name)) {
				dependents.push({ kind: "foreign key", name: child });
			}
		}
	}

	return {
		schema: request.schema,
		name: request.name,
		kind: relationKind,
		tabs: tabsForKind(relationKind),
		rowEstimate,
		estimated: false,
		columns,
		arguments: [],
		indexes,
		constraints,
		triggers,
		grants: [],
		statistics,
		ddl,
		unsupported: UNSUPPORTED,
		ddlReconstructed: false,
		dependents,
	};
}
