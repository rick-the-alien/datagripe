import { createHash } from "node:crypto";
import type {
	ColumnDescriptor,
	ConnectionAdapter,
	ConnectionSource,
	ExecutionCancelResult,
	ExecutionStartRequest,
	ExecutionStartResult,
	ExecutionStatus,
} from "@datagripe/contracts";
import { ADAPTER_CAPABILITIES } from "@datagripe/contracts";
import { ErrorCodes } from "@datagripe/contracts/errors";
import type {
	DatabaseAdapter,
	ExecutionSession,
	ResolvedConnection,
} from "@datagripe/database-adapters";
import { splitOptionsForDialect, splitStatements } from "@datagripe/sql-tools";
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
	workspaceId: string;
	connectionId: string;
	documentId?: string;
	status: ExecutionStatus;
	statements: string[];
	nextSequence: number;
	events: BufferedEvent[];
	session?: ExecutionSession | undefined;
	cancelRequested: boolean;
	cleanupTimer?: ReturnType<typeof setTimeout>;
	/** Set by `runOnce`: the caller wants the rows, not the events. */
	collect?: Collected;
	options: ExecutionOptions;
}

/**
 * What a non-editor caller may change about one execution
 * (docs/spec/mcp.md). Deliberately not part of the wire request: a
 * browser cannot ask for a sandbox, or for someone else's attribution.
 */
export interface ExecutionOptions {
	/** One rolled-back read-only transaction for the whole run. */
	sandbox?: boolean;
	/** Tighter than the server caps, for a caller whose consumer is a
	 * context window rather than a grid. */
	maxRows?: number;
	maxBytes?: number;
	/** History attribution. */
	source?: "editor" | "mcp";
	mcpTokenId?: string;
}

interface Collected {
	sets: Map<number, { columns: ColumnDescriptor[]; rows: unknown[][] }>;
	statements: Array<{ command: string; affectedRows?: number }>;
	rowCount: number;
	truncated: boolean;
	elapsedMs: number;
	error?: { code?: string; message: string; position?: number };
}

/** One execution, awaited to its terminal state, with its last result. */
export interface ExecutionOutcome {
	executionId: string;
	status: ExecutionStatus;
	columns: ColumnDescriptor[];
	rows: unknown[][];
	/** How many result sets the run produced; `rows` is the last one. */
	resultSets: number;
	statements: Array<{ command: string; affectedRows?: number }>;
	rowCount: number;
	truncated: boolean;
	elapsedMs: number;
	error?: { code?: string; message: string; position?: number };
}

export interface ExecutionRegistryDeps {
	adapters: Readonly<Record<ConnectionAdapter, DatabaseAdapter>>;
	appDb: AppDb;
	limits: RegistryLimits;
	resolveConnection: (
		workspace: { id: string; name: string },
		id: string,
	) => Promise<ResolvedConnection & { source: ConnectionSource }>;
	/** Broadcast a sequenced event for an execution. */
	emit: (
		target: { userId: string; workspaceId: string },
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
	/**
	 * Start an execution and wait for it, returning the rows.
	 *
	 * The editor's path is fire-and-forget because a grid fills from
	 * events; a tool call is one request and one answer. Everything else
	 * is identical — same admission check, same history row, same events
	 * broadcast to the workspace — so an agent's query is visible to the
	 * people in the project while it runs.
	 */
	runOnce: (
		userId: string,
		workspace: { id: string; name: string },
		request: ExecutionStartRequest,
		options: ExecutionOptions,
	) => Promise<ExecutionOutcome>;
	cancel: (
		userId: string,
		role: "owner" | "editor" | "viewer",
		executionId: string,
	) => Promise<ExecutionCancelResult>;
	replay: (
		workspaceId: string,
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
	const { adapters, appDb, limits } = deps;
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
		collectEvent(record, topic, payload);
		deps.emit(
			{ userId: record.userId, workspaceId: record.workspaceId },
			record.id,
			topic,
			sequence,
			payload,
		);
	}

	/**
	 * Accumulate what `runOnce` will return. Reading it off the event
	 * stream rather than the sink keeps one description of a result:
	 * whatever the grid would show is what the tool call answers with.
	 */
	function collectEvent(
		record: ExecutionRecord,
		topic: string,
		payload: unknown,
	): void {
		const collect = record.collect;
		if (collect === undefined) {
			return;
		}
		const data = payload as Record<string, unknown>;
		const setFor = (index: number) => {
			const existing = collect.sets.get(index);
			if (existing !== undefined) {
				return existing;
			}
			const created = {
				columns: [] as ColumnDescriptor[],
				rows: [] as unknown[][],
			};
			collect.sets.set(index, created);
			return created;
		};
		switch (topic) {
			case "execution.columns":
				setFor(data.resultSet as number).columns =
					data.columns as ColumnDescriptor[];
				break;
			case "execution.rows":
				setFor(data.resultSet as number).rows.push(
					...(data.rows as unknown[][]),
				);
				break;
			case "execution.progress":
				collect.statements.push({
					command: data.command as string,
					...(typeof data.affectedRows === "number"
						? { affectedRows: data.affectedRows }
						: {}),
				});
				break;
			case "execution.completed":
				collect.rowCount = data.rowCount as number;
				collect.truncated = data.truncated as boolean;
				collect.elapsedMs = data.elapsedMs as number;
				break;
			case "execution.failed":
				collect.error = {
					message: data.message as string,
					...(typeof data.code === "string" ? { code: data.code } : {}),
					...(typeof data.position === "number"
						? { position: data.position }
						: {}),
				};
				break;
			case "execution.cancelled":
				collect.elapsedMs = data.elapsedMs as number;
				break;
			default:
				break;
		}
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
			userId: record.userId,
		});

		let session: ExecutionSession | undefined;
		try {
			// A caller may ask for *less* than the server caps, never more:
			// Math.min, so an option can tighten a limit and not lift one.
			const maxRows = Math.min(
				limits.maxRows,
				record.options.maxRows ?? limits.maxRows,
			);
			const maxBytes = Math.min(
				limits.maxBytes,
				record.options.maxBytes ?? limits.maxBytes,
			);
			session = await adapters[connection.adapter].beginExecution(connection, {
				timeoutMs: limits.timeoutMs,
				maxRows,
				maxBytes,
				batchRows: Math.min(BATCH_ROWS, maxRows),
				readOnly: connection.readOnly,
				sandbox: record.options.sandbox === true,
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

	/**
	 * Admission, resolution, history row and registry entry — everything
	 * both entry points share. It stops short of running so `start` can
	 * hand the socket its id immediately and `runOnce` can await.
	 */
	async function admit(
		userId: string,
		workspace: { id: string; name: string },
		request: ExecutionStartRequest,
		options: ExecutionOptions,
	): Promise<{ record: ExecutionRecord; connection: ResolvedConnection }> {
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

		// Resolve before anything dialect-specific so unknown
		// connections fail fast and the splitter sees the adapter.
		const connection = await deps.resolveConnection(
			workspace,
			request.connectionId,
		);
		if (adapters[connection.adapter].capabilities.execution === null) {
			throw new ServiceError(
				ErrorCodes.BadRequest,
				`Connection '${request.connectionId}' does not support SQL execution`,
			);
		}

		// The dialect is a capability, not the adapter id: they only
		// coincide today, and Redis has no dialect at all.
		const dialect =
			ADAPTER_CAPABILITIES[connection.adapter].sqlDialect ?? "postgres";
		const statements = splitStatements(
			request.sql,
			splitOptionsForDialect(dialect),
		).map((statement) => statement.text);
		if (statements.length === 0) {
			throw new ServiceError(
				ErrorCodes.BadRequest,
				"No executable statement found",
			);
		}

		const id = crypto.randomUUID();
		// `connection_id` is a uuid column, so only a managed datasource
		// can go in it: predefined ids are slugs and git ids are
		// `git:<uuid>`. Everything else is recorded as a ref, which is
		// also what the history view falls back to for a display name.
		const isManaged = connection.source === "managed";
		const ref =
			connection.source === "predefined"
				? `predefined:${request.connectionId}`
				: request.connectionId;
		await appDb`
				INSERT INTO query_executions (
					id, user_id, connection_id, connection_ref, document_id,
					status, query_hash, preview, source, mcp_token_id
				) VALUES (
					${id}, ${userId},
					${isManaged ? request.connectionId : null},
					${isManaged ? null : ref},
					${request.documentId ?? null},
					'queued', ${queryHash(request.sql)},
					${request.sql.slice(0, QUERY_PREVIEW_LENGTH)},
					${options.source ?? "editor"},
					${options.mcpTokenId ?? null}
				)
			`;

		const record: ExecutionRecord = {
			id,
			userId,
			workspaceId: workspace.id,
			connectionId: request.connectionId,
			...(request.documentId !== undefined
				? { documentId: request.documentId }
				: {}),
			status: "queued",
			statements,
			nextSequence: 1,
			events: [],
			cancelRequested: false,
			options,
		};
		records.set(id, record);
		log.audit("execution.start", {
			userId,
			executionId: id,
			connectionId: request.connectionId,
			source: options.source ?? "editor",
			...(options.mcpTokenId === undefined
				? {}
				: { mcpTokenId: options.mcpTokenId }),
		});
		return { record, connection };
	}

	return {
		async start(userId, workspace, request) {
			const { record, connection } = await admit(
				userId,
				workspace,
				request,
				{},
			);
			void run(record, connection);
			return { executionId: record.id };
		},

		async runOnce(userId, workspace, request, options) {
			const { record, connection } = await admit(
				userId,
				workspace,
				request,
				options,
			);
			const collect: Collected = {
				sets: new Map(),
				statements: [],
				rowCount: 0,
				truncated: false,
				elapsedMs: 0,
			};
			record.collect = collect;
			await run(record, connection);
			const indexes = [...collect.sets.keys()].sort((a, b) => a - b);
			const last = indexes[indexes.length - 1];
			const set =
				last === undefined
					? { columns: [], rows: [] }
					: (collect.sets.get(last) ?? { columns: [], rows: [] });
			return {
				executionId: record.id,
				status: record.status,
				columns: set.columns,
				rows: set.rows,
				resultSets: indexes.length,
				statements: collect.statements,
				rowCount: collect.rowCount,
				truncated: collect.truncated,
				elapsedMs: collect.elapsedMs,
				...(collect.error === undefined ? {} : { error: collect.error }),
			};
		},

		async cancel(userId, role, executionId) {
			const record = records.get(executionId);
			if (record === undefined) {
				throw new ServiceError(
					ErrorCodes.NotFound,
					`Execution '${executionId}' not found`,
				);
			}
			// Executors cancel their own; cancelling someone else's needs owner.
			if (record.userId !== userId && role !== "owner") {
				throw new ServiceError(
					ErrorCodes.Forbidden,
					"Only the executor or an owner can cancel an execution",
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
			log.audit("execution.cancel", {
				userId,
				executionId,
				executorUserId: record.userId,
			});
			await record.session?.cancel();
			return { executionId, status: record.status };
		},

		replay(workspaceId, executionId, afterSequence) {
			const record = records.get(executionId);
			// Any workspace member may subscribe (docs/spec/multiplayer.md 6d).
			if (record === undefined || record.workspaceId !== workspaceId) {
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
