import { isRowReturningStatement } from "@datagripe/sql-tools";
import type { ReservedSQL, SQL } from "bun";
import type {
	ExecuteLimits,
	ExecutionRunResult,
	ExecutionSession,
	ExecutionSink,
	ResolvedConnection,
} from "../types";

/**
 * PostgreSQL execution on a reserved connection (docs/spec/query-execution.md):
 * SELECT-ish statements stream through a server-side cursor in FETCH
 * batches; other statements run directly. Cancellation uses
 * pg_cancel_backend from a separate pooled connection — Bun.SQL's
 * query.cancel() is client-side only (verified on Bun 1.4).
 */

const USER_CANCEL_MESSAGE = "canceling statement due to user request";
const TIMEOUT_MESSAGE = "canceling statement due to statement timeout";
const QUERY_TIMEOUT_CODE = "QUERY_TIMEOUT";

type Reserved = ReservedSQL;

/** JSON-safe, size-bounded value normalization for the wire. */
function normalizeValue(value: unknown): unknown {
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

interface RunState {
	rowCount: number;
	bytes: number;
	truncated: boolean;
}

export async function beginPostgresExecution(
	client: SQL,
	_connection: ResolvedConnection,
	limits: ExecuteLimits,
): Promise<ExecutionSession> {
	const reserved = await client.reserve();
	try {
		// Integer from server config — safe to inline; SET does not take binds.
		await reserved.unsafe(
			`SET statement_timeout = ${Math.max(1, Math.floor(limits.timeoutMs))}`,
		);
		if (limits.readOnly) {
			await reserved.unsafe("SET default_transaction_read_only = on");
		}
		const pidRows = await reserved.unsafe("SELECT pg_backend_pid() AS pid");
		const pid = Number(pidRows[0]?.pid);
		if (!Number.isInteger(pid)) {
			throw new Error("Could not determine backend pid");
		}
		return new PostgresExecutionSession(client, reserved, pid, limits);
	} catch (error) {
		reserved.release();
		throw error;
	}
}

class PostgresExecutionSession implements ExecutionSession {
	constructor(
		private readonly client: SQL,
		private readonly reserved: Reserved,
		readonly backendPid: number,
		private readonly limits: ExecuteLimits,
	) {}

	async cancel(): Promise<void> {
		// Administrative control path: a different connection, never blocked
		// by the running statement.
		await this.client.unsafe("SELECT pg_cancel_backend($1) AS cancelled", [
			this.backendPid,
		]);
	}

	async close(): Promise<void> {
		this.reserved.release();
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
				if (isRowReturningStatement(statement)) {
					const fetched = await this.runCursor(
						resultSet + 1,
						statement,
						sink,
						state,
					);
					if (fetched !== null) {
						resultSet++;
						sink.statementDone(index, {
							command: "SELECT",
							affectedRows: fetched,
						});
					} else {
						// DECLARE failed (e.g. WITH … DML) — direct execution.
						resultSet = await this.runDirect(
							resultSet,
							statement,
							sink,
							state,
							index,
						);
					}
				} else {
					resultSet = await this.runDirect(
						resultSet,
						statement,
						sink,
						state,
						index,
					);
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
			if (shouldStop() || message.includes(USER_CANCEL_MESSAGE)) {
				return {
					outcome: "cancelled",
					rowCount: state.rowCount,
					truncated: state.truncated,
				};
			}
			if (message.includes(TIMEOUT_MESSAGE)) {
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

	/**
	 * Normalize and emit rows under the row/byte caps. Returns false when
	 * a cap was hit (state.truncated set).
	 */
	private emitRows(
		resultSet: number,
		records: Array<Record<string, unknown>>,
		offset: number,
		sink: ExecutionSink,
		state: RunState,
	): void {
		if (records.length === 0) {
			return;
		}
		const columns = Object.keys(records[0] as Record<string, unknown>);
		const fitted: unknown[][] = [];
		for (const record of records) {
			if (state.rowCount + fitted.length >= this.limits.maxRows) {
				state.truncated = true;
				break;
			}
			const row = columns.map((column) => normalizeValue(record[column]));
			const size = JSON.stringify(row).length;
			if (state.bytes + size > this.limits.maxBytes) {
				state.truncated = true;
				break;
			}
			state.bytes += size;
			fitted.push(row);
		}
		if (fitted.length > 0) {
			sink.rows(resultSet, fitted, offset);
			state.rowCount += fitted.length;
		}
	}

	/** Cursor path. Returns rows fetched, or null when DECLARE failed and
	 * the caller must fall back to direct execution. */
	private async runCursor(
		resultSet: number,
		statement: string,
		sink: ExecutionSink,
		state: RunState,
	): Promise<number | null> {
		await this.reserved.unsafe("BEGIN");
		try {
			await this.reserved.unsafe(
				`DECLARE dg_cur NO SCROLL CURSOR FOR ${statement}`,
			);
		} catch (error) {
			await this.reserved.unsafe("ROLLBACK").catch(() => {});
			const message = error instanceof Error ? error.message : "";
			if (
				message.includes(USER_CANCEL_MESSAGE) ||
				message.includes(TIMEOUT_MESSAGE)
			) {
				throw error;
			}
			return null;
		}

		let offset = 0;
		let columnsSent = false;
		try {
			for (;;) {
				const batch = (await this.reserved.unsafe(
					`FETCH ${this.limits.batchRows} FROM dg_cur`,
				)) as Array<Record<string, unknown>>;
				if (!columnsSent) {
					const columns =
						batch.length > 0
							? Object.keys(batch[0] as Record<string, unknown>)
							: [];
					sink.columns(
						resultSet,
						columns.map((name) => ({ name, dataType: "unknown" })),
					);
					columnsSent = true;
				}
				if (batch.length === 0 || state.truncated) {
					break;
				}
				this.emitRows(resultSet, batch, offset, sink, state);
				offset += batch.length;
			}
		} finally {
			await this.reserved.unsafe("CLOSE dg_cur").catch(() => {});
			await this.reserved.unsafe("ROLLBACK").catch(() => {});
		}
		return offset;
	}

	/** Direct path; returns the (possibly incremented) result-set index. */
	private async runDirect(
		resultSet: number,
		statement: string,
		sink: ExecutionSink,
		state: RunState,
		index: number,
	): Promise<number> {
		const result = (await this.reserved.unsafe(statement)) as Array<
			Record<string, unknown>
		> & { command?: string; count?: number };
		if (
			result.length > 0 &&
			typeof result[0] === "object" &&
			result[0] !== null
		) {
			const columns = Object.keys(result[0]);
			sink.columns(
				resultSet + 1,
				columns.map((name) => ({ name, dataType: "unknown" })),
			);
			this.emitRows(resultSet + 1, result, 0, sink, state);
			sink.statementDone(index, {
				command: result.command ?? "SELECT",
				...(typeof result.count === "number"
					? { affectedRows: result.count }
					: {}),
			});
			return resultSet + 1;
		}
		sink.statementDone(index, {
			command: result.command ?? "OK",
			...(typeof result.count === "number"
				? { affectedRows: result.count }
				: {}),
		});
		return resultSet;
	}
}
