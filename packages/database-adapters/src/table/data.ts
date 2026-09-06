import type { TableColumn } from "@datagripe/contracts";
import type {
	TableLimits,
	TableMutateOutcome,
	TableMutateRequest,
	TableReadRequest,
	TableReadResult,
} from "../types";
import {
	assertNoUpdateDefaults,
	deleteStatement,
	editabilityReason,
	insertStatement,
	selectCount,
	selectPage,
	type TableDialect,
	TableRequestError,
	updateStatement,
	type WritableRelation,
} from "./builder";

/**
 * Dialect-independent table read/write flow (docs/spec/table-view.md).
 * Each adapter supplies a session — statement timeout and read-only
 * semantics are the adapter's business — plus the two catalog queries
 * that differ per engine.
 */

export interface TableSession {
	/** Run one row-returning statement, returning rows as objects. */
	query: (
		sql: string,
		params: unknown[],
	) => Promise<Array<Record<string, unknown>>>;
	/** Run one write, returning affected rows when the driver reports it. */
	write: (sql: string, params: unknown[]) => Promise<number | undefined>;
}

export interface TableCatalog {
	/** Columns in ordinal order, with primary-key and generated flags. */
	describe: (
		session: TableSession,
		schema: string,
		table: string,
	) => Promise<TableColumn[]>;
	/** Planner row estimate, or null when the engine has none. */
	estimate?: (
		session: TableSession,
		schema: string,
		table: string,
	) => Promise<number | null>;
	/** True when `SET col = DEFAULT` is available on update. */
	supportsUpdateDefault: boolean;
}

export function keyColumnsOf(columns: TableColumn[]): string[] {
	return columns
		.filter((column) => column.primaryKey)
		.map((column) => column.name);
}

/**
 * Grid cells round-trip through JSON and back through an editable text
 * box, so driver-native values are flattened to something a text field
 * can show and re-send. bigint would make JSON.stringify throw outright.
 */
export function normalizeCell(value: unknown): unknown {
	if (value === undefined) {
		return null;
	}
	if (typeof value === "bigint") {
		return value.toString();
	}
	if (value instanceof Date) {
		return value.toISOString();
	}
	if (value instanceof Uint8Array) {
		return `\\x${Buffer.from(value).toString("hex")}`;
	}
	return value;
}

function rowsToArrays(
	rows: Array<Record<string, unknown>>,
	columns: TableColumn[],
): unknown[][] {
	return rows.map((row) =>
		columns.map((column) => normalizeCell(row[column.name])),
	);
}

export async function readTablePage(options: {
	session: TableSession;
	dialect: TableDialect;
	catalog: TableCatalog;
	request: TableReadRequest;
	limits: TableLimits;
	readOnlyConnection: boolean;
}): Promise<TableReadResult> {
	const { session, dialect, catalog, request, limits } = options;
	const columns = await catalog.describe(
		session,
		request.schema,
		request.table,
	);
	if (columns.length === 0) {
		throw new TableRequestError(
			`Relation '${request.schema}.${request.table}' has no readable columns`,
		);
	}
	const limit = Math.min(request.limit, limits.maxRows);
	const page = selectPage(dialect, {
		schema: request.schema,
		table: request.table,
		columns,
		sort: request.sort,
		filter: request.filter,
		limit,
		offset: request.offset,
	});
	const rows = await session.query(page.sql, page.params);

	let totalRows: number | null = null;
	let estimated = false;
	if (request.count) {
		const hasFilter = request.filter.trim() !== "";
		const estimate =
			hasFilter || catalog.estimate === undefined
				? null
				: await catalog.estimate(session, request.schema, request.table);
		if (estimate !== null && estimate > limits.estimateAboveRows) {
			totalRows = estimate;
			estimated = true;
		} else {
			const counted = selectCount(dialect, {
				schema: request.schema,
				table: request.table,
				filter: request.filter,
			});
			const countRows = await session.query(counted.sql, counted.params);
			const value = Number(countRows[0]?.dg_total);
			if (Number.isFinite(value)) {
				totalRows = value;
			} else {
				totalRows = estimate;
				estimated = estimate !== null;
			}
		}
	}

	const keyColumns = keyColumnsOf(columns);
	const reason = editabilityReason({
		kind: request.kind,
		readOnly: options.readOnlyConnection,
		keyColumns,
	});
	return {
		columns,
		rows: rowsToArrays(rows, columns),
		totalRows,
		estimated,
		editable: reason === null,
		...(reason !== null ? { reason } : {}),
	};
}

/**
 * Apply grid edits. The caller has already opened a transaction; every
 * statement must touch exactly one row or the whole batch is rejected,
 * which is what makes a mistyped primary key a failure rather than a
 * mass update.
 */
export async function applyTableEdits(options: {
	session: TableSession;
	dialect: TableDialect;
	catalog: TableCatalog;
	request: TableMutateRequest;
}): Promise<TableMutateOutcome> {
	const { session, dialect, catalog, request } = options;
	const columns = await catalog.describe(
		session,
		request.schema,
		request.table,
	);
	const keyColumns = keyColumnsOf(columns);
	if (keyColumns.length === 0) {
		throw new TableRequestError(
			"This table has no primary key, so a row cannot be addressed",
		);
	}
	const relation: WritableRelation = {
		schema: request.schema,
		table: request.table,
		columns,
		keyColumns,
	};

	let applied = 0;
	for (const edit of request.edits) {
		if (edit.type === "update" && !catalog.supportsUpdateDefault) {
			assertNoUpdateDefaults(edit.values);
		}
		const statement =
			edit.type === "insert"
				? insertStatement(dialect, relation, edit)
				: edit.type === "update"
					? updateStatement(dialect, relation, edit)
					: deleteStatement(dialect, relation, edit);
		const affected = await session.write(statement.sql, statement.params);
		if (affected === undefined) {
			// Driver did not report a count; the statement still ran and the
			// key predicate is provably single-row.
			applied += 1;
			continue;
		}
		if (affected !== 1) {
			throw new TableRequestError(
				edit.type === "insert"
					? "The insert did not add exactly one row"
					: `The ${edit.type} matched ${affected} rows — the row changed underneath you; refresh and retry`,
			);
		}
		applied += 1;
	}
	return { applied };
}
