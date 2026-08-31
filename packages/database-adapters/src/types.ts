import type {
	AdapterCapabilities,
	ConnectionAdapter,
	ConnectionTestResult,
	SchemaNode,
	SchemaPathSegment,
} from "@datagripe/contracts";

/**
 * A connection with its secret resolved in server memory, immediately
 * before use. Adapters never see ciphertext and never persist this.
 * File-based adapters (SQLite) leave host/port/username empty and carry
 * the file path in `database`.
 */
export interface ResolvedConnection {
	adapter: ConnectionAdapter;
	host: string;
	port: number;
	database: string;
	username: string;
	password: string;
	tlsMode: "disable" | "require" | "verify-full";
	readOnly: boolean;
}

/** One key's value from a keyspace adapter (Redis). */
export interface KeyValue {
	key: string;
	type: "string" | "hash" | "list" | "set" | "zset" | "other";
	ttlSeconds: number;
	entries: Array<{ field?: string; value: string }>;
	truncated: boolean;
}

/**
 * Target-database adapter boundary (docs/initial_idea.md §6). Every
 * adapter reports honest `capabilities`; the dispatcher and UI gate on
 * those, never on the adapter id.
 */
export interface DatabaseAdapter {
	readonly adapterId: ConnectionAdapter;
	readonly capabilities: AdapterCapabilities;
	testConnection(connection: ResolvedConnection): Promise<ConnectionTestResult>;
	introspectChildren(
		connection: ResolvedConnection,
		path: SchemaPathSegment[],
	): Promise<SchemaNode[]>;
	/** Reserve a target connection for one execution. Only called when
	 * capabilities.execution is non-null. */
	beginExecution(
		connection: ResolvedConnection,
		limits: ExecuteLimits,
	): Promise<ExecutionSession>;
	/** Fetch one key's value (keyspace adapters only). */
	getKeyValue?(connection: ResolvedConnection, key: string): Promise<KeyValue>;
	/** Close every pooled target client this adapter created. */
	close(): Promise<void>;
}

/** Thrown for introspection paths that do not match the tree shape. */
export class InvalidIntrospectionPathError extends Error {
	constructor(path: SchemaPathSegment[]) {
		super(
			`Invalid introspection path: ${JSON.stringify(
				path.map((segment) => `${segment.kind}:${segment.name}`),
			)}`,
		);
		this.name = "InvalidIntrospectionPathError";
	}
}

/** Server-enforced execution limits (docs/spec/query-execution.md). */
export interface ExecuteLimits {
	timeoutMs: number;
	maxRows: number;
	maxBytes: number;
	/** Rows per FETCH batch. */
	batchRows: number;
	/** Run the whole session with default_transaction_read_only = on. */
	readOnly: boolean;
}

export interface ExecutionSink {
	columns(
		resultSet: number,
		columns: Array<{ name: string; dataType: string }>,
	): void;
	rows(resultSet: number, rows: unknown[][], rowOffset: number): void;
	statementDone(
		statementIndex: number,
		info: { command: string; affectedRows?: number },
	): void;
}

export interface ExecutionError {
	code?: string;
	message: string;
}

export interface ExecutionRunResult {
	outcome: "completed" | "cancelled" | "failed";
	rowCount: number;
	truncated: boolean;
	error?: ExecutionError;
}

/**
 * One live execution on a reserved target connection. `cancel` uses a
 * separate administrative connection (pg_cancel_backend), so it is never
 * blocked by the running statement.
 */
export interface ExecutionSession {
	readonly backendPid: number;
	run(
		statements: string[],
		sink: ExecutionSink,
		shouldStop: () => boolean,
	): Promise<ExecutionRunResult>;
	cancel(): Promise<void>;
	close(): Promise<void>;
}
