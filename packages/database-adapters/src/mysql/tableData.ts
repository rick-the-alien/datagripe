import type { TableColumn } from "@datagripe/contracts";
import type { SQL } from "bun";
import { MYSQL_TABLE_DIALECT, TableRequestError } from "../table/builder";
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
 * MySQL table view (docs/spec/table-view.md). max_execution_time bounds
 * the read; the read itself runs in a read-only transaction. `SET col =
 * DEFAULT` is not portable across MySQL column types, so update-to-
 * default is rejected rather than half-supported.
 */

// Every projection is aliased: MySQL returns information_schema column
// names upper-cased, so unaliased fields arrive as IS_NULLABLE.
const COLUMNS_SQL = `
	SELECT column_name AS name,
		column_type AS data_type,
		is_nullable AS is_nullable,
		column_key AS column_key,
		extra AS extra,
		column_default AS column_default
	FROM information_schema.columns
	WHERE table_schema = ? AND table_name = ?
	ORDER BY ordinal_position`;

const ESTIMATE_SQL = `
	SELECT table_rows AS estimate
	FROM information_schema.tables
	WHERE table_schema = ? AND table_name = ?`;

const catalog: TableCatalog = {
	supportsUpdateDefault: false,

	async describe(session, schema, table) {
		const rows = await session.query(COLUMNS_SQL, [schema, table]);
		return rows.map((row): TableColumn => {
			const extra = String(row.extra ?? "").toUpperCase();
			return {
				name: String(row.name),
				dataType: String(row.data_type),
				nullable: String(row.is_nullable).toUpperCase() === "YES",
				primaryKey: String(row.column_key).toUpperCase() === "PRI",
				// auto_increment is writable; a generated column is not.
				generated: extra.includes("GENERATED"),
				hasDefault:
					row.column_default !== null || extra.includes("AUTO_INCREMENT"),
			};
		});
	},

	async estimate(session, schema, table) {
		const rows = await session.query(ESTIMATE_SQL, [schema, table]);
		const value = Number(rows[0]?.estimate);
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
				affectedRows?: number;
				count?: number;
			};
			const affected = result.affectedRows ?? result.count;
			return typeof affected === "number" ? affected : undefined;
		},
	};
}

export async function readMysqlTable(
	client: SQL,
	readOnlyConnection: boolean,
	request: TableReadRequest,
	limits: TableLimits,
): Promise<TableReadResult> {
	const reserved = await client.reserve();
	try {
		await reserved.unsafe(
			`SET SESSION max_execution_time = ${Math.max(
				1,
				Math.floor(limits.timeoutMs),
			)}`,
		);
		await reserved.unsafe("START TRANSACTION READ ONLY");
		try {
			return await readTablePage({
				session: sessionFor(reserved),
				dialect: MYSQL_TABLE_DIALECT,
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

export async function mutateMysqlTable(
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
			`SET SESSION max_execution_time = ${Math.max(
				1,
				Math.floor(limits.timeoutMs),
			)}`,
		);
		await reserved.unsafe("START TRANSACTION");
		try {
			const outcome = await applyTableEdits({
				session: sessionFor(reserved),
				dialect: MYSQL_TABLE_DIALECT,
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
