import { createHash } from "node:crypto";
import type {
	ExecutionCancelResult,
	ExecutionStartRequest,
	ExecutionStartResult,
	ExecutionStatus,
} from "@datagripe/contracts";
import { ErrorCodes } from "@datagripe/contracts/errors";
import type {
	DatabaseAdapter,
	ExecutionSession,
	ResolvedConnection,
} from "@datagripe/database-adapters";
import { splitStatements } from "@datagripe/sql-tools";
import { ServiceError } from "../connections/service";
import type { AppDb } from "../db/app/pool";
import { log } from "../log";

/**
 * Execution registry (docs/spec/query-execution.md): owns lifecycle,
 * limits admission, event buffering/replay, cancellation, and history
 * rows. Server-side execution state lives here; sockets are subscribers.
 */

export interface RegistryLimits {
	timeoutMs: number;
	maxRows: number;
	maxBytes: number;
	maxConcurrentPerUser: number;
}

export interface BufferedEvent {
	sequence: number;
	topic: string;
	payload: unknown;
}

interface ExecutionRecord {
	id: string;
	userId: string;
	connectionId: string;
	documentId?: string;
	status: ExecutionStatus;
	statements: string[];
	nextSequence: number;
	events: BufferedEvent[];
	session?: ExecutionSession | undefined;
	cancelRequested: boolean;
	cleanupTimer?: ReturnType<typeof setTimeout>;
}

export interface ExecutionRegistryDeps {
	adapter: DatabaseAdapter;
	appDb: AppDb;
	limits: RegistryLimits;
	resolveConnection: (
		workspace: { id: string; name: string },
		id: string,
	) => Promise<ResolvedConnection & { source: "managed" | "predefined" }>;
	/** Broadcast a sequenced event for an execution. */
	emit: (
		userId: string,
		executionId: string,
		topic: string,
		sequence: number,
		payload: unknown,
	) => void;
}

export interface ExecutionRegistry {
	start: (
		userId: string,
		workspace: { id: string; name: string },
		request: ExecutionStartRequest,
	) => Promise<ExecutionStartResult>;
	cancel: (
		userId: string,
		executionId: string,
	) => Promise<ExecutionCancelResult>;
	replay: (
		userId: string,
		executionId: string,
		afterSequence: number,
	) => BufferedEvent[];
	/** Test/inspection seam. */
	get: (executionId: string) => { status: ExecutionStatus } | undefined;
}

const BATCH_ROWS = 500;
const ROW_EVENT_BUFFER = 50;
const TERMINAL_TTL_MS = 5 * 60_000;
const QUERY_PREVIEW_LENGTH = 200;

function queryHash(sql: string): string {
	return createHash("sha256").update(sql).digest("hex");
}

export function createExecutionRegistry(
	deps: ExecutionRegistryDeps,
): ExecutionRegistry {
	const { adapter, appDb, limits } = deps;
	const records = new Map<string, ExecutionRecord>();

	function bufferEvent(
		record: ExecutionRecord,
		topic: string,
		payload: unknown,
	): void {
		const sequence = record.nextSequence++;
		record.events.push({ sequence, topic, payload });
		// Bound memory: lifecycle events stay; old row batches drop first.
		const rowEvents = record.events.filter(
			(event) => event.topic === "execution.rows",
		);
		if (rowEvents.length > ROW_EVENT_BUFFER) {
			const drop = new Set(
				rowEvents
					.slice(0, rowEvents.length - ROW_EVENT_BUFFER)
					.map((event) => event.sequence),
			);
			record.events = record.events.filter(
				(event) => !drop.has(event.sequence),
			);
		}
		deps.emit(record.userId, record.id, topic, sequence, payload);
	}

	function finish(
		record: ExecutionRecord,
		status: ExecutionStatus,
		update: {
			rowCount?: number | undefined;
			truncated?: boolean | undefined;
			errorCode?: string | undefined;
		},
	): void {
		record.status = status;
		record.session = undefined;
		void appDb`
			UPDATE query_executions SET
				status = ${status},
				finished_at = now(),
				row_count = ${update.rowCount ?? null},
				truncated = ${update.truncated ?? null},
				error_code = ${update.errorCode ?? null}
			WHERE id = ${record.id}
		`.catch(() => {});
		record.cleanupTimer = setTimeout(() => {
			records.delete(record.id);
		}, TERMINAL_TTL_MS);
	}

	async function run(
		record: ExecutionRecord,
		connection: ResolvedConnection,
	): Promise<void> {
		const startedAt = new Date().toISOString();
		record.status = "running";
		await appDb`
			UPDATE query_executions SET status = 'running', started_at = now()
			WHERE id = ${record.id}
		`.catch(() => {});
		bufferEvent(record, "execution.started", {
			startedAt,
			statements: record.statements.length,
		});

		let session: ExecutionSession | undefined;
		try {
			session = await adapter.beginExecution(connection, {
				timeoutMs: limits.timeoutMs,
				maxRows: limits.maxRows,
				maxBytes: limits.maxBytes,
				batchRows: BATCH_ROWS,
				readOnly: connection.readOnly,
			});
			record.session = session;

			const result = await session.run(
				record.statements,
				{
					columns: (resultSet, columns) => {
						bufferEvent(record, "execution.columns", { resultSet, columns });
					},
					rows: (resultSet, rows, rowOffset) => {
						bufferEvent(record, "execution.rows", {
							resultSet,
							rows,
							rowOffset,
						});
					},
					statementDone: (statement, info) => {
						bufferEvent(record, "execution.progress", {
							statement: statement + 1,
							command: info.command,
							...(info.affectedRows !== undefined
								? { affectedRows: info.affectedRows }
								: {}),
						});
					},
				},
				() => record.cancelRequested,
			);

			const elapsedMs = Math.round(Date.now() - new Date(startedAt).getTime());
			if (result.outcome === "completed") {
				bufferEvent(record, "execution.completed", {
					rowCount: result.rowCount,
					truncated: result.truncated,
					elapsedMs,
					statements: record.statements.length,
				});
				finish(record, "succeeded", {
					rowCount: result.rowCount,
					truncated: result.truncated,
				});
			} else if (result.outcome === "cancelled") {
				bufferEvent(record, "execution.cancelled", { elapsedMs });
				finish(record, "cancelled", {
					rowCount: result.rowCount,
					truncated: result.truncated,
				});
			} else {
				bufferEvent(record, "execution.failed", {
					...(result.error?.code !== undefined
						? { code: result.error.code }
						: {}),
					message: result.error?.message ?? "Execution failed",
				});
				finish(record, "failed", {
					rowCount: result.rowCount,
					truncated: result.truncated,
					errorCode: result.error?.code,
				});
			}
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			bufferEvent(record, "execution.failed", { message });
			finish(record, "failed", {});
		} finally {
			record.session = undefined;
			await session?.close().catch(() => {});
		}
	}

	return {
		async start(userId, workspace, request) {
			const running = [...records.values()].filter(
				(record) =>
					record.userId === userId &&
					(record.status === "queued" || record.status === "running"),
			).length;
			if (running >= limits.maxConcurrentPerUser) {
				throw new ServiceError(
					ErrorCodes.RateLimited,
					`Too many concurrent queries (limit ${limits.maxConcurrentPerUser})`,
				);
			}

			const statements = splitStatements(request.sql).map(
				(statement) => statement.text,
			);
			if (statements.length === 0) {
				throw new ServiceError(
					ErrorCodes.BadRequest,
					"No executable statement found",
				);
			}

			// Resolve before inserting history so unknown connections fail fast.
			const connection = await deps.resolveConnection(
				workspace,
				request.connectionId,
			);

			const id = crypto.randomUUID();
			const isPredefined = connection.source === "predefined";
			await appDb`
				INSERT INTO query_executions (
					id, user_id, connection_id, connection_ref, document_id,
					status, query_hash, preview
				) VALUES (
					${id}, ${userId},
					${isPredefined ? null : request.connectionId},
					${isPredefined ? `predefined:${request.connectionId}` : null},
					${request.documentId ?? null},
					'queued', ${queryHash(request.sql)},
					${request.sql.slice(0, QUERY_PREVIEW_LENGTH)}
				)
			`;

			const record: ExecutionRecord = {
				id,
				userId,
				connectionId: request.connectionId,
				...(request.documentId !== undefined
					? { documentId: request.documentId }
					: {}),
				status: "queued",
				statements,
				nextSequence: 1,
				events: [],
				cancelRequested: false,
			};
			records.set(id, record);
			log.audit("execution.start", {
				userId,
				executionId: id,
				connectionId: request.connectionId,
			});
			void run(record, connection);
			return { executionId: id };
		},

		async cancel(userId, executionId) {
			const record = records.get(executionId);
			// Same response for missing and foreign executions — no existence leak.
			if (record === undefined || record.userId !== userId) {
				throw new ServiceError(
					ErrorCodes.NotFound,
					`Execution '${executionId}' not found`,
				);
			}
			if (
				record.status === "succeeded" ||
				record.status === "failed" ||
				record.status === "cancelled"
			) {
				// Idempotent: cancelling a terminal execution returns its state.
				return { executionId, status: record.status };
			}
			record.cancelRequested = true;
			log.audit("execution.cancel", { userId, executionId });
			await record.session?.cancel();
			return { executionId, status: record.status };
		},

		replay(userId, executionId, afterSequence) {
			const record = records.get(executionId);
			if (record === undefined || record.userId !== userId) {
				throw new ServiceError(
					ErrorCodes.NotFound,
					`Execution '${executionId}' not found`,
				);
			}
			return record.events.filter((event) => event.sequence > afterSequence);
		},

		get(executionId) {
			const record = records.get(executionId);
			return record === undefined ? undefined : { status: record.status };
		},
	};
}
