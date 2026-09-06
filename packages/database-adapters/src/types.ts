import type {
	AdapterCapabilities,
	ColumnChange,
	ConnectionAdapter,
	ConnectionTestResult,
	ObjectAlterResult,
	ObjectDescribeResult,
	ObjectKind,
	SchemaNode,
	SchemaPathSegment,
	TableColumn,
	TableEdit,
	TableSort,
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
	/** Read one page of a relation. Present when capabilities.tableData
	 * is non-null. */
	readTable?(
		connection: ResolvedConnection,
		request: TableReadRequest,
		limits: TableLimits,
	): Promise<TableReadResult>;
	/** Apply single-row grid edits in one transaction. Present when
	 * capabilities.tableData is "readwrite". */
	mutateTable?(
		connection: ResolvedConnection,
		request: TableMutateRequest,
		limits: TableLimits,
	): Promise<TableMutateOutcome>;
	/** Everything the object view's tabs need, in one call. Present when
	 * capabilities.introspection is "sql". */
	describeObject?(
		connection: ResolvedConnection,
		request: ObjectRequest,
		limits: TableLimits,
	): Promise<ObjectDescribeResult>;
	/** Preview or apply column changes. Which change kinds are available
	 * is capabilities.columnChanges. */
	alterColumns?(
		connection: ResolvedConnection,
		request: ObjectAlterExecution,
		limits: TableLimits,
	): Promise<ObjectAlterResult>;
	/** Close every pooled target client this adapter created. */
	close(): Promise<void>;
}

/** Server-enforced bounds for table-view reads and writes. */
export interface TableLimits {
	timeoutMs: number;
	/** Hard cap on a page, independent of the requested limit. */
	maxRows: number;
	/**
	 * Above this many estimated rows, the footer count comes from planner
	 * statistics instead of COUNT(*) — a full count on a 40M-row table is
	 * not worth the wait for a number nobody reads precisely.
	 */
	estimateAboveRows: number;
}

export interface TableReadRequest {
	schema: string;
	table: string;
	kind: "table" | "view";
	limit: number;
	offset: number;
	sort: TableSort[];
	filter: string;
	count: boolean;
}

export interface TableReadResult {
	columns: TableColumn[];
	rows: unknown[][];
	totalRows: number | null;
	estimated: boolean;
	editable: boolean;
	reason?: string;
}

export interface TableMutateRequest {
	schema: string;
	table: string;
	edits: TableEdit[];
}

export interface TableMutateOutcome {
	applied: number;
}

/** A column-change batch, or a request to preview one. */
export interface ObjectAlterExecution {
	schema: string;
	name: string;
	changes: ColumnChange[];
	/** Build the statements and stop — the preview step. */
	dryRun: boolean;
}

/** One object to describe for the object view. */
export interface ObjectRequest {
	schema: string;
	name: string;
	kind: ObjectKind;
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
