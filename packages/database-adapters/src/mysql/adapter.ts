import type {
	ConnectionTestResult,
	ObjectAlterResult,
	ObjectDescribeResult,
	SchemaNode,
	SchemaPathSegment,
} from "@datagripe/contracts";
import { ADAPTER_CAPABILITIES } from "@datagripe/contracts";
import { type ReservedSQL, SQL } from "bun";
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
import { alterMysqlColumns } from "./alterData";
import { describeMysqlObject } from "./objectData";
import { mutateMysqlTable, readMysqlTable } from "./tableData";

/**
 * MySQL adapter over Bun.SQL (docs/spec/adapters.md). Execution is
 * buffered (no server-side cursor in MySQL for arbitrary SELECTs) with
 * caps applied on fetch; cancellation uses KILL QUERY from a second
 * connection — never blocked by the running statement.
 */

const USER_CANCEL_MARKER = "Query execution was interrupted";
const TIMEOUT_MARKER = "max_execution_time";
const QUERY_TIMEOUT_CODE = "QUERY_TIMEOUT";

type Reserved = ReservedSQL;

export class MysqlAdapter implements DatabaseAdapter {
	readonly adapterId = "mysql" as const;
	readonly capabilities = ADAPTER_CAPABILITIES.mysql;

	private readonly clients = new Map<string, SQL>();

	private clientFor(connection: ResolvedConnection): SQL {
		const passwordFingerprint = new Bun.CryptoHasher("sha256")
			.update(connection.password)
			.digest("hex")
			.slice(0, 16);
		const key = [
			connection.host,
			connection.port,
			connection.database,
			connection.username,
			connection.tlsMode,
			passwordFingerprint,
		].join(":");
		let client = this.clients.get(key);
		if (client === undefined) {
			client = new SQL({
				adapter: "mysql",
				hostname: connection.host,
				port: connection.port,
				database: connection.database,
				username: connection.username,
				password: connection.password,
				tls: connection.tlsMode !== "disable",
				// caching_sha2_password over plain TCP needs key retrieval;
				// acceptable on trusted local links, never with TLS modes.
				allowPublicKeyRetrieval: connection.tlsMode === "disable",
				max: 3,
				idleTimeout: 20,
				connectionTimeout: 10,
			});
			this.clients.set(key, client);
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
			)`SELECT VERSION() AS version`;
			const version =
				typeof rows[0]?.version === "string" ? rows[0].version : undefined;
			return {
				ok: true,
				latencyMs: Math.round(performance.now() - started),
				...(version !== undefined ? { serverVersion: version } : {}),
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
			const rows = await sql`
				SELECT schema_name AS name
				FROM information_schema.schemata
				WHERE schema_name NOT IN ('mysql', 'information_schema', 'performance_schema', 'sys')
				ORDER BY schema_name
			`;
			return rows.map((row: { name: string }) => ({
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
		const schemaName = schemaSegment.name;

		if (path.length === 1) {
			return [
				{ kind: "tables", name: "tables", hasChildren: true },
				{ kind: "views", name: "views", hasChildren: true },
				{ kind: "functions", name: "functions", hasChildren: true },
				{ kind: "procedures", name: "procedures", hasChildren: true },
			];
		}

		if (categorySegment === undefined) {
			throw new InvalidIntrospectionPathError(path);
		}

		if (path.length === 2) {
			// Routines are leaf objects: only tables/views descend to columns.
			// MySQL has no overloading, so routine names are unique per schema.
			if (
				categorySegment.kind === "functions" ||
				categorySegment.kind === "procedures"
			) {
				const routineType =
					categorySegment.kind === "functions" ? "FUNCTION" : "PROCEDURE";
				const kind =
					categorySegment.kind === "functions" ? "function" : "procedure";
				const rows = await sql`
					SELECT routine_name AS name
					FROM information_schema.routines
					WHERE routine_schema = ${schemaName}
						AND routine_type = ${routineType}
					ORDER BY routine_name
				`;
				return rows.map((row: { name: string }) => ({
					kind: kind as "function" | "procedure",
					name: row.name,
					hasChildren: false,
				}));
			}
			if (
				categorySegment.kind !== "tables" &&
				categorySegment.kind !== "views"
			) {
				throw new InvalidIntrospectionPathError(path);
			}
			const tableType =
				categorySegment.kind === "tables" ? "BASE TABLE" : "VIEW";
			const kind = categorySegment.kind === "tables" ? "table" : "view";
			const rows = await sql`
				SELECT table_name AS name
				FROM information_schema.tables
				WHERE table_schema = ${schemaName}
					AND table_type = ${tableType}
				ORDER BY table_name
			`;
			return rows.map((row: { name: string }) => ({
				kind: kind as "table" | "view",
				name: row.name,
				hasChildren: true,
			}));
		}

		if (
			objectSegment === undefined ||
			(categorySegment.kind !== "tables" && categorySegment.kind !== "views") ||
			(categorySegment.kind === "tables" && objectSegment.kind !== "table") ||
			(categorySegment.kind === "views" && objectSegment.kind !== "view")
		) {
			throw new InvalidIntrospectionPathError(path);
		}

		const rows = await sql`
			SELECT column_name AS name, data_type AS "dataType", is_nullable AS nullable
			FROM information_schema.columns
			WHERE table_schema = ${schemaName}
				AND table_name = ${objectSegment.name}
			ORDER BY ordinal_position
		`;
		return rows.map(
			(row: { name: string; dataType: string; nullable: string }) => ({
				kind: "column" as const,
				name: row.name,
				hasChildren: false,
				dataType: row.dataType,
				nullable: row.nullable === "YES",
			}),
		);
	}

	async beginExecution(
		connection: ResolvedConnection,
		limits: ExecuteLimits,
	): Promise<ExecutionSession> {
		const client = this.clientFor(connection);
		const reserved = await client.reserve();
		try {
			// max_execution_time (ms) bounds read statements server-side.
			await reserved.unsafe(
				`SET SESSION max_execution_time = ${Math.max(1, Math.floor(limits.timeoutMs))}`,
			);
			if (limits.readOnly) {
				await reserved.unsafe("SET SESSION transaction_read_only = 1");
			}
			const idRows = await reserved.unsafe("SELECT CONNECTION_ID() AS id");
			const connectionId = Number(idRows[0]?.id);
			if (!Number.isInteger(connectionId)) {
				throw new Error("Could not determine connection id");
			}
			return new MysqlExecutionSession(client, reserved, connectionId, limits);
		} catch (error) {
			reserved.release();
			throw error;
		}
	}

	readTable(
		connection: ResolvedConnection,
		request: TableReadRequest,
		limits: TableLimits,
	): Promise<TableReadResult> {
		return readMysqlTable(
			this.clientFor(connection),
			connection.readOnly,
			request,
			limits,
		);
	}

	mutateTable(
		connection: ResolvedConnection,
		request: TableMutateRequest,
		limits: TableLimits,
	): Promise<TableMutateOutcome> {
		return mutateMysqlTable(
			this.clientFor(connection),
			connection.readOnly,
			request,
			limits,
		);
	}

	describeObject(
		connection: ResolvedConnection,
		request: ObjectRequest,
		limits: TableLimits,
	): Promise<ObjectDescribeResult> {
		return describeMysqlObject(this.clientFor(connection), request, limits);
	}

	alterColumns(
		connection: ResolvedConnection,
		request: ObjectAlterExecution,
		limits: TableLimits,
	): Promise<ObjectAlterResult> {
		return alterMysqlColumns(
			this.clientFor(connection),
			connection,
			request,
			limits,
		);
	}

	async close(): Promise<void> {
		await Promise.all(
			[...this.clients.values()].map((client) => client.close()),
		);
		this.clients.clear();
	}
}

class MysqlExecutionSession implements ExecutionSession {
	private cancelIssued = false;

	constructor(
		private readonly client: SQL,
		private readonly reserved: Reserved,
		readonly backendPid: number,
		private readonly limits: ExecuteLimits,
	) {}

	async cancel(): Promise<void> {
		// Administrative control path: a different connection, never blocked
		// by the running statement. Bun's driver resolves killed statements
		// cleanly, so the flag — not the error — carries the outcome.
		this.cancelIssued = true;
		await this.client.unsafe(`KILL QUERY ${this.backendPid}`);
	}

	async close(): Promise<void> {
		this.reserved.release();
	}

	/**
	 * Bun's MySQL driver resolves interrupted statements cleanly (SLEEP
	 * returns 1, no error, no warning), so outcomes are tracked
	 * out-of-band: cancelIssued for KILL QUERY, a watchdog for timeouts.
	 * max_execution_time stays set server-side as the primary bound; the
	 * watchdog is the deterministic backstop.
	 */

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
				let timedOut = false;
				const watchdog = setTimeout(() => {
					timedOut = true;
					void this.cancel().catch(() => {});
				}, this.limits.timeoutMs);
				const statementStarted = performance.now();
				let result: Array<Record<string, unknown>> & {
					command?: string;
					count?: number;
				};
				try {
					result = (await this.reserved.unsafe(statement)) as typeof result;
				} finally {
					clearTimeout(watchdog);
				}
				if (
					timedOut ||
					performance.now() - statementStarted >= this.limits.timeoutMs
				) {
					return {
						outcome: "failed",
						rowCount: state.rowCount,
						truncated: state.truncated,
						error: {
							code: QUERY_TIMEOUT_CODE,
							message: `Statement exceeded the ${this.limits.timeoutMs} ms timeout`,
						},
					};
				}
				if (this.cancelIssued || shouldStop()) {
					return {
						outcome: "cancelled",
						rowCount: state.rowCount,
						truncated: state.truncated,
					};
				}
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
			if (shouldStop() || this.cancelIssued) {
				return {
					outcome: "cancelled",
					rowCount: state.rowCount,
					truncated: state.truncated,
				};
			}
			return {
				outcome: "completed",
				rowCount: state.rowCount,
				truncated: state.truncated,
			};
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			if (shouldStop() || message.includes(USER_CANCEL_MARKER)) {
				return {
					outcome: "cancelled",
					rowCount: state.rowCount,
					truncated: state.truncated,
				};
			}
			if (message.includes(TIMEOUT_MARKER)) {
				return {
					outcome: "failed",
					rowCount: state.rowCount,
					truncated: state.truncated,
					error: { code: QUERY_TIMEOUT_CODE, message },
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
