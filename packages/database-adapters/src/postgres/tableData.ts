import type { TableColumn } from "@datagripe/contracts";
import type { SQL } from "bun";
import { POSTGRES_TABLE_DIALECT, TableRequestError } from "../table/builder";
import {
	applyTableEdits,
	readTablePage,
	type TableCatalog,
	type TableSession,
} from "../table/data";
import type {
	TableLimits,
	TableMutateOutcome,
	TableMutateRequest,
	TableReadRequest,
	TableReadResult,
} from "../types";

/**
 * PostgreSQL table view (docs/spec/table-view.md). Reads run inside a
 * READ ONLY transaction with a statement timeout, so the user's `where …`
 * fragment cannot write no matter what it contains. Writes run in one
 * transaction that rolls back unless every statement touched one row.
 */

const COLUMNS_SQL = `
	SELECT a.attname AS name,
		format_type(a.atttypid, a.atttypmod) AS data_type,
		NOT a.attnotnull AS nullable,
		COALESCE(pk.is_pk, false) AS primary_key,
		(a.attidentity = 'a' OR a.attgenerated <> '') AS generated,
		(a.atthasdef OR a.attidentity <> '') AS has_default
	FROM pg_attribute a
	JOIN pg_class c ON c.oid = a.attrelid
	JOIN pg_namespace n ON n.oid = c.relnamespace
	LEFT JOIN (
		SELECT conrelid, unnest(conkey) AS attnum, true AS is_pk
		FROM pg_constraint
		WHERE contype = 'p'
	) pk ON pk.conrelid = c.oid AND pk.attnum = a.attnum
	WHERE n.nspname = $1
		AND c.relname = $2
		AND a.attnum > 0
		AND NOT a.attisdropped
	ORDER BY a.attnum`;

const ESTIMATE_SQL = `
	SELECT c.reltuples::bigint AS estimate
	FROM pg_class c
	JOIN pg_namespace n ON n.oid = c.relnamespace
	WHERE n.nspname = $1 AND c.relname = $2`;

const catalog: TableCatalog = {
	supportsUpdateDefault: true,

	async describe(session, schema, table) {
		const rows = await session.query(COLUMNS_SQL, [schema, table]);
		return rows.map(
			(row): TableColumn => ({
				name: String(row.name),
				dataType: String(row.data_type),
				nullable: row.nullable === true,
				primaryKey: row.primary_key === true,
				generated: row.generated === true,
				hasDefault: row.has_default === true,
			}),
		);
	},

	async estimate(session, schema, table) {
		const rows = await session.query(ESTIMATE_SQL, [schema, table]);
		const value = Number(rows[0]?.estimate);
		// -1 means "never analysed"; treat it as no estimate at all.
		return Number.isFinite(value) && value >= 0 ? value : null;
	},
};

function sessionFor(reserved: {
	unsafe: (sql: string, params?: unknown[]) => Promise<unknown>;
}): TableSession {
	return {
		query: async (sql, params) =>
			(await reserved.unsafe(sql, params)) as Array<Record<string, unknown>>,
		write: async (sql, params) => {
			const result = (await reserved.unsafe(sql, params)) as {
				count?: number;
			};
			return typeof result.count === "number" ? result.count : undefined;
		},
	};
}

export async function readPostgresTable(
	client: SQL,
	readOnlyConnection: boolean,
	request: TableReadRequest,
	limits: TableLimits,
): Promise<TableReadResult> {
	const reserved = await client.reserve();
	try {
		await reserved.unsafe(
			`SET statement_timeout = ${Math.max(1, Math.floor(limits.timeoutMs))}`,
		);
		await reserved.unsafe("BEGIN READ ONLY");
		try {
			return await readTablePage({
				session: sessionFor(reserved),
				dialect: POSTGRES_TABLE_DIALECT,
				catalog,
				request,
				limits,
				readOnlyConnection,
			});
		} finally {
			await reserved.unsafe("ROLLBACK").catch(() => {});
		}
	} finally {
		reserved.release();
	}
}

export async function mutatePostgresTable(
	client: SQL,
	readOnlyConnection: boolean,
	request: TableMutateRequest,
	limits: TableLimits,
): Promise<TableMutateOutcome> {
	if (readOnlyConnection) {
		throw new TableRequestError("This datasource is read-only");
	}
	const reserved = await client.reserve();
	try {
		await reserved.unsafe(
			`SET statement_timeout = ${Math.max(1, Math.floor(limits.timeoutMs))}`,
		);
		await reserved.unsafe("BEGIN");
		try {
			const outcome = await applyTableEdits({
				session: sessionFor(reserved),
				dialect: POSTGRES_TABLE_DIALECT,
				catalog,
				request,
			});
			await reserved.unsafe("COMMIT");
			return outcome;
		} catch (error) {
			await reserved.unsafe("ROLLBACK").catch(() => {});
			throw error;
		}
	} finally {
		reserved.release();
	}
}
