import type { TableColumn } from "@datagripe/contracts";
import type { SQL } from "bun";
import { SQLITE_TABLE_DIALECT, TableRequestError } from "../table/builder";
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
 * SQLite table view (docs/spec/table-view.md). PRAGMA takes no binds, so
 * the schema and table names are quoted into it — the same defensive
 * quoting the introspection path already uses. Databases are local files
 * and COUNT(*) is a full scan, so there is no estimate to prefer.
 */

const catalog: TableCatalog = {
	supportsUpdateDefault: false,

	async describe(session, schema, table) {
		const quotedSchema = schema.replaceAll('"', '""');
		const quotedTable = table.replaceAll('"', '""');
		// table_xinfo exposes generated columns (hidden 2 = VIRTUAL,
		// 3 = STORED); hidden 1 is a virtual-table hidden column, which is
		// not selectable and must be dropped.
		const rows = await session.query(
			`PRAGMA "${quotedSchema}".table_xinfo("${quotedTable}")`,
			[],
		);
		return rows
			.filter((row) => Number(row.hidden ?? 0) !== 1)
			.map((row): TableColumn => {
				const hidden = Number(row.hidden ?? 0);
				return {
					name: String(row.name),
					dataType: String(row.type || "unknown"),
					nullable: Number(row.notnull) === 0,
					primaryKey: Number(row.pk) > 0,
					generated: hidden === 2 || hidden === 3,
					hasDefault: row.dflt_value !== null,
				};
			});
	},
};

function sessionFor(client: {
	unsafe: (sql: string, params?: unknown[]) => Promise<unknown>;
}): TableSession {
	return {
		query: async (sql, params) =>
			(await client.unsafe(sql, params)) as Array<Record<string, unknown>>,
		write: async (sql, params) => {
			const result = (await client.unsafe(sql, params)) as {
				changes?: number;
				count?: number;
			};
			const affected = result.changes ?? result.count;
			return typeof affected === "number" ? affected : undefined;
		},
	};
}

export async function readSqliteTable(
	client: SQL,
	readOnlyConnection: boolean,
	request: TableReadRequest,
	limits: TableLimits,
): Promise<TableReadResult> {
	return readTablePage({
		session: sessionFor(client),
		dialect: SQLITE_TABLE_DIALECT,
		catalog,
		request,
		limits,
		readOnlyConnection,
	});
}

/**
 * Bun's SQLite adapter is a single handle with no connection
 * reservation, so two concurrent batches would interleave their
 * BEGIN/COMMIT on the same transaction. Mutations are chained per client
 * instead — one file, one writer at a time, which is also what SQLite
 * itself wants.
 */
const writeQueues = new WeakMap<object, Promise<unknown>>();

function serialize<T>(client: object, work: () => Promise<T>): Promise<T> {
	const previous = writeQueues.get(client) ?? Promise.resolve();
	const next = previous.then(work, work);
	writeQueues.set(
		client,
		next.catch(() => {}),
	);
	return next;
}

export async function mutateSqliteTable(
	client: SQL,
	readOnlyConnection: boolean,
	request: TableMutateRequest,
): Promise<TableMutateOutcome> {
	if (readOnlyConnection) {
		throw new TableRequestError("This datasource is read-only");
	}
	const session = sessionFor(client);
	return serialize(client, async () => {
		await session.query("BEGIN", []);
		try {
			const outcome = await applyTableEdits({
				session,
				dialect: SQLITE_TABLE_DIALECT,
				catalog,
				request,
			});
			await session.query("COMMIT", []);
			return outcome;
		} catch (error) {
			await session.query("ROLLBACK", []).catch(() => {});
			throw error;
		}
	});
}
