import type {
	ConnectionTestResult,
	ObjectAlterResult,
	ObjectDescribeResult,
	SchemaNode,
	SchemaPathSegment,
} from "@datagripe/contracts";
import { ADAPTER_CAPABILITIES } from "@datagripe/contracts";
import { SQL } from "bun";
import { emitRows, type RunState } from "../execute/common";
import type { ExecutionSink } from "../types";
import {
	type DatabaseAdapter,
	type ExecuteLimits,
	type ExecutionRunResult,
	type ExecutionSession,
	InvalidIntrospectionPathError,
	type ObjectAlterExecution,
	type ObjectRequest,
	type ResolvedConnection,
	type TableLimits,
	type TableMutateOutcome,
	type TableMutateRequest,
	type TableReadRequest,
	type TableReadResult,
} from "../types";
import { alterSqliteColumns } from "./alterData";
import { describeSqliteObject } from "./objectData";
import { mutateSqliteTable, readSqliteTable } from "./tableData";

/**
 * SQLite adapter over Bun.SQL (docs/spec/adapters.md). Connections point
 * at server-side file paths (`database` carries the path). Execution is
 * buffered with caps applied on fetch; cancellation is not supported by
 * the driver (capabilities.cancellation === false — queries are local
 * and bounded by row/byte caps instead).
 */

export class SqliteAdapter implements DatabaseAdapter {
	readonly adapterId = "sqlite" as const;
	readonly capabilities = ADAPTER_CAPABILITIES.sqlite;

	private readonly clients = new Map<string, SQL>();

	private clientFor(connection: ResolvedConnection): SQL {
		let client = this.clients.get(connection.database);
		if (client === undefined) {
			client = new SQL({
				adapter: "sqlite",
				filename: connection.database,
				readonly: connection.readOnly,
			});
			this.clients.set(connection.database, client);
		}
		return client;
	}

	async testConnection(
		connection: ResolvedConnection,
	): Promise<ConnectionTestResult> {
		const started = performance.now();
		try {
			const rows = await this.clientFor(
				connection,
			)`SELECT sqlite_version() AS version`;
			const version =
				typeof rows[0]?.version === "string" ? rows[0].version : undefined;
			return {
				ok: true,
				latencyMs: Math.round(performance.now() - started),
				...(version !== undefined
					? { serverVersion: `SQLite ${version}` }
					: {}),
			};
		} catch (error) {
			return {
				ok: false,
				error: {
					message: error instanceof Error ? error.message : "Connection failed",
				},
			};
		}
	}

	async introspectChildren(
		connection: ResolvedConnection,
		path: SchemaPathSegment[],
	): Promise<SchemaNode[]> {
		const sql = this.clientFor(connection);

		if (path.length === 0) {
			// Databases act as schemas; attached databases included.
			const rows = await sql`PRAGMA database_list`;
			return (rows as Array<{ name: string }>).map((row) => ({
				kind: "schema" as const,
				name: row.name,
				hasChildren: true,
			}));
		}

		const [schemaSegment, categorySegment, objectSegment] = path;
		if (
			schemaSegment === undefined ||
			schemaSegment.kind !== "schema" ||
			path.length > 3
		) {
			throw new InvalidIntrospectionPathError(path);
		}
		// Schema/object names come from our own tree, but quote defensively.
		const schemaName = schemaSegment.name.replaceAll('"', '""');

		if (path.length === 1) {
			return [
				{ kind: "tables", name: "tables", hasChildren: true },
				{ kind: "views", name: "views", hasChildren: true },
			];
		}

		if (
			categorySegment === undefined ||
			(categorySegment.kind !== "tables" && categorySegment.kind !== "views")
		) {
			throw new InvalidIntrospectionPathError(path);
		}

		if (path.length === 2) {
			const objectType = categorySegment.kind === "tables" ? "table" : "view";
			const rows = await sql`
				SELECT name FROM ${sql.unsafe(`"${schemaName}"`)}.sqlite_master
				WHERE type = ${objectType} AND name NOT LIKE 'sqlite_%'
				ORDER BY name
			`;
			return (rows as Array<{ name: string }>).map((row) => ({
				kind: objectType as "table" | "view",
				name: row.name,
				hasChildren: true,
			}));
		}

		if (
			objectSegment === undefined ||
			(categorySegment.kind === "tables" && objectSegment.kind !== "table") ||
			(categorySegment.kind === "views" && objectSegment.kind !== "view")
		) {
			throw new InvalidIntrospectionPathError(path);
		}

		const objectName = objectSegment.name.replaceAll('"', '""');
		const rows = await sql.unsafe(
			`PRAGMA "${schemaName}".table_info("${objectName}")`,
		);
		return (
			rows as Array<{
				name: string;
				type: string;
				notnull: number;
			}>
		).map((row) => ({
			kind: "column" as const,
			name: row.name,
			hasChildren: false,
			dataType: row.type || "unknown",
			nullable: row.notnull === 0,
		}));
	}

	async beginExecution(
		connection: ResolvedConnection,
		limits: ExecuteLimits,
	): Promise<ExecutionSession> {
		// Bun's SQLite adapter does not support reserve(); the per-file
		// client IS the dedicated connection, so the session wraps it
		// directly (close is a no-op — the adapter owns its lifecycle).
		return new SqliteExecutionSession(this.clientFor(connection), limits);
	}

	readTable(
		connection: ResolvedConnection,
		request: TableReadRequest,
		limits: TableLimits,
	): Promise<TableReadResult> {
		return readSqliteTable(
			this.clientFor(connection),
			connection.readOnly,
			request,
			limits,
		);
	}

	mutateTable(
		connection: ResolvedConnection,
		request: TableMutateRequest,
	): Promise<TableMutateOutcome> {
		return mutateSqliteTable(
			this.clientFor(connection),
			connection.readOnly,
			request,
		);
	}

	describeObject(
		connection: ResolvedConnection,
		request: ObjectRequest,
	): Promise<ObjectDescribeResult> {
		return describeSqliteObject(this.clientFor(connection), request);
	}

	alterColumns(
		connection: ResolvedConnection,
		request: ObjectAlterExecution,
	): Promise<ObjectAlterResult> {
		return alterSqliteColumns(this.clientFor(connection), connection, request);
	}

	async close(): Promise<void> {
		await Promise.all(
			[...this.clients.values()].map((client) => client.close()),
		);
		this.clients.clear();
	}
}

class SqliteExecutionSession implements ExecutionSession {
	readonly backendPid = 0;

	constructor(
		private readonly client: SQL,
		private readonly limits: ExecuteLimits,
	) {}

	async cancel(): Promise<void> {
		// No driver-level interrupt; capabilities.cancellation === false
		// means the UI never offers this. The query finishes and its
		// terminal event reports normally.
	}

	async close(): Promise<void> {
		// The client is shared per file; the adapter owns its lifecycle.
	}

	async run(
		statements: string[],
		sink: ExecutionSink,
		shouldStop: () => boolean,
	): Promise<ExecutionRunResult> {
		const state: RunState = { rowCount: 0, bytes: 0, truncated: false };
		let resultSet = -1;
		try {
			for (const [index, statement] of statements.entries()) {
				if (shouldStop()) {
					return {
						outcome: "cancelled",
						rowCount: state.rowCount,
						truncated: state.truncated,
					};
				}
				const result = (await this.client.unsafe(statement)) as Array<
					Record<string, unknown>
				> & { command?: string; count?: number };

				if (
					result.length > 0 &&
					typeof result[0] === "object" &&
					result[0] !== null
				) {
					resultSet++;
					const columns = Object.keys(result[0]);
					sink.columns(
						resultSet,
						columns.map((name) => ({ name, dataType: "unknown" })),
					);
					emitRows(this.limits, state, resultSet, result, 0, sink);
					sink.statementDone(index, {
						command: result.command ?? "SELECT",
						...(typeof result.count === "number"
							? { affectedRows: result.count }
							: {}),
					});
				} else {
					sink.statementDone(index, {
						command: result.command ?? "OK",
						...(typeof result.count === "number"
							? { affectedRows: result.count }
							: {}),
					});
				}
				if (state.truncated) {
					break;
				}
			}
			return {
				outcome: "completed",
				rowCount: state.rowCount,
				truncated: state.truncated,
			};
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			if (shouldStop()) {
				return {
					outcome: "cancelled",
					rowCount: state.rowCount,
					truncated: state.truncated,
				};
			}
			return {
				outcome: "failed",
				rowCount: state.rowCount,
				truncated: state.truncated,
				error: { message },
			};
		}
	}
}
