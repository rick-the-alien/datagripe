import type {
	AdapterInfo,
	ConnectionAdapter,
	ConnectionCreateRequest,
	ConnectionMetadata,
	ConnectionTestRequest,
	ConnectionTestResult,
	ConnectionUpdateRequest,
	ObjectAlterRequest,
	ObjectAlterResult,
	ObjectDescribeRequest,
	ObjectDescribeResult,
	RedisGetResult,
	SchemaNode,
	SchemaPathSegment,
	TableMutateRequest,
	TableMutateResult,
	TableRowsRequest,
	TableRowsResult,
} from "@datagripe/contracts";
import { adapterInfoOf } from "@datagripe/contracts";
import { ErrorCodes } from "@datagripe/contracts/errors";
import type {
	DatabaseAdapter,
	ResolvedConnection,
	TableLimits,
} from "@datagripe/database-adapters";
import { TableRequestError } from "@datagripe/database-adapters";
import type { SecretKeyring } from "../crypto/keyring";
import type { AppDb } from "../db/app/pool";
import { log } from "../log";
import type { SsrfPolicy } from "../security/ssrf";
import type { PredefinedEntry } from "./predefined";

/** Domain error with a protocol error code. */
export class ServiceError extends Error {
	readonly code: string;

	constructor(code: string, message: string) {
		super(message);
		this.name = "ServiceError";
		this.code = code;
	}
}

export const ConnectionErrorCodes = {
	ReadOnly: "CONNECTION_READ_ONLY",
} as const;

type ConnectionRow = {
	id: string;
	workspace_id: string;
	name: string;
	adapter: ConnectionAdapter;
	host: string | null;
	port: number | null;
	database_name: string;
	username: string | null;
	tls_mode: "disable" | "require" | "verify-full" | null;
	read_only: boolean;
	show_all_schemas: boolean;
	created_at: string;
	updated_at: string;
};

export interface WorkspaceRef {
	id: string;
	name: string;
}

export interface ConnectionsServiceDeps {
	appDb: AppDb;
	keyring: SecretKeyring;
	adapters: Readonly<Record<ConnectionAdapter, DatabaseAdapter>>;
	predefined: ReadonlyMap<string, PredefinedEntry>;
	ssrf: SsrfPolicy;
	/** Introspection cache TTL in ms (default 30s). */
	introspectionCacheTtlMs?: number;
	/** Bounds for table-view reads and writes; defaults match the
	 * query-execution caps. */
	tableLimits?: TableLimits;
}

export interface ConnectionsService {
	listConnections: (workspace: WorkspaceRef) => Promise<ConnectionMetadata[]>;
	createConnection: (
		workspace: WorkspaceRef,
		request: ConnectionCreateRequest,
	) => Promise<ConnectionMetadata>;
	updateConnection: (
		workspace: WorkspaceRef,
		request: ConnectionUpdateRequest,
	) => Promise<ConnectionMetadata>;
	deleteConnection: (workspace: WorkspaceRef, id: string) => Promise<void>;
	testConnection: (
		workspace: WorkspaceRef,
		request: ConnectionTestRequest,
	) => Promise<ConnectionTestResult>;
	schemaChildren: (
		workspace: WorkspaceRef,
		connectionId: string,
		path: SchemaPathSegment[],
		refresh: boolean,
	) => Promise<SchemaNode[]>;
	/** Resolve a connection with its secret for server-side execution.
	 * Never exposed over the wire. */
	resolveForExecution: (
		workspace: WorkspaceRef,
		connectionId: string,
	) => Promise<ResolvedConnection & { source: "managed" | "predefined" }>;
	/** Display name of a predefined connection, for history rendering. */
	predefinedName: (connectionId: string) => string | undefined;
	/** Adapter for a resolved connection's dialect. */
	adapterFor: (adapter: ConnectionAdapter) => DatabaseAdapter;
	/** Whether a connection ref (managed UUID or predefined:<slug>) is
	 * usable in this workspace. */
	hasConnectionRef: (workspace: WorkspaceRef, ref: string) => Promise<boolean>;
	/** Capability descriptors for every registered adapter. */
	adapterInfos: () => AdapterInfo[];
	/** Fetch one key's value (keyspace adapters). */
	getKeyValue: (
		workspace: WorkspaceRef,
		connectionId: string,
		key: string,
	) => Promise<RedisGetResult>;
	/** One page of a relation for the table view. */
	readTable: (
		workspace: WorkspaceRef,
		request: TableRowsRequest,
	) => Promise<TableRowsResult>;
	/** Apply single-row grid edits. */
	mutateTable: (
		workspace: WorkspaceRef,
		request: TableMutateRequest,
	) => Promise<TableMutateResult>;
	/** Every object-view tab for one relation, in one call. */
	describeObject: (
		workspace: WorkspaceRef,
		request: ObjectDescribeRequest,
	) => Promise<ObjectDescribeResult>;
	/** Preview (dryRun) or apply column changes. */
	alterColumns: (
		workspace: WorkspaceRef,
		request: ObjectAlterRequest,
	) => Promise<ObjectAlterResult>;
}

function rowToMetadata(row: ConnectionRow): ConnectionMetadata {
	return {
		id: row.id,
		workspaceId: row.workspace_id,
		name: row.name,
		adapter: row.adapter,
		host: row.host,
		port: row.port,
		databaseName: row.database_name,
		username: row.username,
		tlsMode: row.tls_mode,
		readOnly: row.read_only,
		showAllSchemas: row.show_all_schemas,
		source: "managed",
		createdAt: row.created_at,
		updatedAt: row.updated_at,
	};
}

export function createConnectionsService(
	deps: ConnectionsServiceDeps,
): ConnectionsService {
	const { appDb, keyring, adapters, predefined, ssrf } = deps;
	const tableLimits: TableLimits = deps.tableLimits ?? {
		timeoutMs: 30_000,
		maxRows: 5_000,
		estimateAboveRows: 100_000,
	};
	const cacheTtl = deps.introspectionCacheTtlMs ?? 30_000;
	const introspectionCache = new Map<
		string,
		{ expiresAt: number; nodes: SchemaNode[] }
	>();

	function predefinedMetadata(
		workspace: WorkspaceRef,
		entry: PredefinedEntry,
	): ConnectionMetadata {
		const { definition } = entry;
		return {
			id: definition.id,
			workspaceId: workspace.id,
			name: definition.name,
			adapter: definition.adapter,
			host: definition.host ?? null,
			port: definition.port ?? null,
			databaseName: definition.database,
			username: definition.username ?? null,
			tlsMode: definition.tlsMode,
			readOnly: definition.readOnly,
			showAllSchemas: definition.showAllSchemas,
			source: "predefined",
			createdAt: entry.loadedAt,
			updatedAt: entry.loadedAt,
		};
	}

	function visiblePredefined(workspace: WorkspaceRef): PredefinedEntry[] {
		return [...predefined.values()].filter(
			(entry) =>
				entry.definition.workspaces.includes("*") ||
				entry.definition.workspaces.includes(workspace.name),
		);
	}

	function requireManagedId(id: string): void {
		if (predefined.has(id)) {
			throw new ServiceError(
				ConnectionErrorCodes.ReadOnly,
				`Connection '${id}' is defined by server configuration and is read-only`,
			);
		}
	}

	async function guardHost(host: string): Promise<void> {
		try {
			await ssrf.assertHostAllowed(host);
		} catch (error) {
			log.audit("ssrf.blocked", {
				host,
				error: error instanceof Error ? error.message : String(error),
			});
			throw error;
		}
	}

	/**
	 * Table-view failures come in two flavours and both belong to the
	 * caller: a request we rejected before touching the database, and a
	 * statement the target database rejected. The second one carries the
	 * driver's message through — "invalid input syntax for type integer"
	 * is the whole answer, and "Internal error" is none of it.
	 */
	function asServiceError(error: unknown): Error {
		if (error instanceof TableRequestError) {
			return new ServiceError(ErrorCodes.BadRequest, error.message);
		}
		if (error instanceof ServiceError) {
			return error;
		}
		const message = error instanceof Error ? error.message : String(error);
		log.debug("table action failed on target", { error: message });
		return new ServiceError(ErrorCodes.TargetError, message);
	}

	async function resolveConnection(
		workspace: WorkspaceRef,
		id: string,
	): Promise<ResolvedConnection> {
		const entry = predefined.get(id);
		if (entry !== undefined) {
			if (entry.resolved.host !== "") {
				await guardHost(entry.resolved.host);
			}
			return entry.resolved;
		}
		const rows = await appDb<
			(ConnectionRow & { ciphertext: Buffer; key_version: number })[]
		>`
			SELECT c.*, s.ciphertext, s.key_version
			FROM connections c
			JOIN connection_secrets s ON s.connection_id = c.id
			WHERE c.id = ${id} AND c.workspace_id = ${workspace.id}
		`;
		const row = rows[0];
		if (row === undefined) {
			throw new ServiceError(
				ErrorCodes.NotFound,
				`Connection '${id}' not found`,
			);
		}
		if (row.host !== null) {
			await guardHost(row.host);
		}
		return {
			adapter: row.adapter,
			host: row.host ?? "",
			port: row.port ?? 0,
			database: row.database_name,
			username: row.username ?? "",
			password: keyring.decrypt(row.ciphertext, row.key_version),
			tlsMode: row.tls_mode ?? "disable",
			readOnly: row.read_only,
		};
	}

	return {
		async listConnections(workspace) {
			const rows = await appDb<ConnectionRow[]>`
				SELECT * FROM connections
				WHERE workspace_id = ${workspace.id}
				ORDER BY name
			`;
			return [
				...visiblePredefined(workspace).map((entry) =>
					predefinedMetadata(workspace, entry),
				),
				...rows.map(rowToMetadata),
			].sort((a, b) => a.name.localeCompare(b.name));
		},

		async createConnection(workspace, request) {
			if (request.host !== undefined) {
				await guardHost(request.host);
			}
			const secret = keyring.encrypt(request.password);
			const rows = await appDb.begin(async (tx) => {
				const inserted = await tx<ConnectionRow[]>`
					INSERT INTO connections (
						workspace_id, name, adapter, host, port,
						database_name, username, tls_mode, read_only, show_all_schemas
					) VALUES (
						${workspace.id}, ${request.name}, ${request.adapter},
						${request.host ?? null}, ${request.port ?? null}, ${request.databaseName},
						${request.username ?? null}, ${request.tlsMode ?? null}, ${request.readOnly},
						${request.showAllSchemas}
					)
					RETURNING *
				`;
				const row = inserted[0];
				if (row === undefined) {
					throw new ServiceError(ErrorCodes.Internal, "Insert returned no row");
				}
				await tx`
					INSERT INTO connection_secrets (connection_id, ciphertext, key_version)
					VALUES (${row.id}, ${secret.ciphertext}, ${secret.keyVersion})
				`;
				return inserted;
			});
			const row = rows[0];
			if (row === undefined) {
				throw new ServiceError(ErrorCodes.Internal, "Insert returned no row");
			}
			log.audit("connection.create", {
				workspaceId: workspace.id,
				connectionId: row.id,
			});
			return rowToMetadata(row);
		},

		async updateConnection(workspace, request) {
			requireManagedId(request.id);
			if (request.host !== undefined) {
				await guardHost(request.host);
			}
			const existing = await appDb<ConnectionRow[]>`
				SELECT * FROM connections
				WHERE id = ${request.id} AND workspace_id = ${workspace.id}
			`;
			if (existing[0] === undefined) {
				throw new ServiceError(
					ErrorCodes.NotFound,
					`Connection '${request.id}' not found`,
				);
			}
			const merged = {
				name: request.name ?? existing[0].name,
				host: request.host ?? existing[0].host,
				port: request.port ?? existing[0].port,
				database_name: request.databaseName ?? existing[0].database_name,
				username: request.username ?? existing[0].username,
				tls_mode: request.tlsMode ?? existing[0].tls_mode,
				read_only: request.readOnly ?? existing[0].read_only,
				show_all_schemas:
					request.showAllSchemas ?? existing[0].show_all_schemas,
			};
			const rows = await appDb.begin(async (tx) => {
				const updated = await tx<ConnectionRow[]>`
					UPDATE connections SET
						name = ${merged.name},
						host = ${merged.host},
						port = ${merged.port},
						database_name = ${merged.database_name},
						username = ${merged.username},
						tls_mode = ${merged.tls_mode},
						read_only = ${merged.read_only},
						show_all_schemas = ${merged.show_all_schemas},
						updated_at = now()
					WHERE id = ${request.id}
					RETURNING *
				`;
				if (request.password !== undefined) {
					const secret = keyring.encrypt(request.password);
					await tx`
						UPDATE connection_secrets SET
							ciphertext = ${secret.ciphertext},
							key_version = ${secret.keyVersion},
							updated_at = now()
						WHERE connection_id = ${request.id}
					`;
				}
				return updated;
			});
			const row = rows[0];
			if (row === undefined) {
				throw new ServiceError(ErrorCodes.Internal, "Update returned no row");
			}
			log.audit("connection.update", {
				workspaceId: workspace.id,
				connectionId: row.id,
			});
			return rowToMetadata(row);
		},

		async deleteConnection(workspace, id) {
			requireManagedId(id);
			const rows = await appDb<{ id: string }[]>`
				DELETE FROM connections
				WHERE id = ${id} AND workspace_id = ${workspace.id}
				RETURNING id
			`;
			if (rows[0] === undefined) {
				throw new ServiceError(
					ErrorCodes.NotFound,
					`Connection '${id}' not found`,
				);
			}
			log.audit("connection.delete", {
				workspaceId: workspace.id,
				connectionId: id,
			});
		},

		async testConnection(workspace, request) {
			let resolved: ResolvedConnection;
			if ("connectionId" in request) {
				resolved = await resolveConnection(workspace, request.connectionId);
			} else {
				if (request.draft.host !== undefined) {
					await guardHost(request.draft.host);
				}
				resolved = {
					adapter: request.draft.adapter,
					host: request.draft.host ?? "",
					port: request.draft.port ?? 0,
					database: request.draft.databaseName,
					username: request.draft.username ?? "",
					password: request.draft.password,
					tlsMode: request.draft.tlsMode ?? "disable",
					readOnly: request.draft.readOnly,
				};
			}
			return adapters[resolved.adapter].testConnection(resolved);
		},

		async resolveForExecution(workspace, connectionId) {
			const resolved = await resolveConnection(workspace, connectionId);
			return {
				...resolved,
				source: predefined.has(connectionId) ? "predefined" : "managed",
			};
		},

		predefinedName(connectionId) {
			return predefined.get(connectionId)?.definition.name;
		},

		adapterFor(adapter) {
			return adapters[adapter];
		},

		async hasConnectionRef(workspace, ref) {
			if (ref.startsWith("predefined:")) {
				const slug = ref.slice("predefined:".length);
				const entry = predefined.get(slug);
				return (
					entry !== undefined &&
					(entry.definition.workspaces.includes("*") ||
						entry.definition.workspaces.includes(workspace.name))
				);
			}
			const rows = await appDb<{ id: string }[]>`
				SELECT id FROM connections
				WHERE id = ${ref} AND workspace_id = ${workspace.id}
			`;
			return rows.length > 0;
		},

		adapterInfos() {
			return Object.values(adapters).map((adapter) =>
				adapterInfoOf(adapter.adapterId, adapter.capabilities),
			);
		},

		async getKeyValue(workspace, connectionId, key) {
			const resolved = await resolveConnection(workspace, connectionId);
			const adapter = adapters[resolved.adapter];
			if (adapter.getKeyValue === undefined) {
				throw new ServiceError(
					ErrorCodes.BadRequest,
					`Connection '${connectionId}' does not support key browsing`,
				);
			}
			return adapter.getKeyValue(resolved, key);
		},

		async readTable(workspace, request) {
			const resolved = await resolveConnection(workspace, request.connectionId);
			const adapter = adapters[resolved.adapter];
			if (adapter.readTable === undefined) {
				throw new ServiceError(
					ErrorCodes.BadRequest,
					`Connection '${request.connectionId}' has no table view`,
				);
			}
			try {
				const result = await adapter.readTable(
					resolved,
					{
						schema: request.schema,
						table: request.table,
						kind: request.kind,
						limit: request.limit,
						offset: request.offset,
						sort: request.sort,
						filter: request.filter,
						count: request.count,
					},
					tableLimits,
				);
				return {
					...result,
					offset: request.offset,
					limit: Math.min(request.limit, tableLimits.maxRows),
				};
			} catch (error) {
				throw asServiceError(error);
			}
		},

		async mutateTable(workspace, request) {
			const resolved = await resolveConnection(workspace, request.connectionId);
			const adapter = adapters[resolved.adapter];
			if (
				adapter.mutateTable === undefined ||
				adapter.capabilities.tableData !== "readwrite"
			) {
				throw new ServiceError(
					ErrorCodes.BadRequest,
					`Connection '${request.connectionId}' cannot be edited in the grid`,
				);
			}
			if (resolved.readOnly) {
				throw new ServiceError(
					ConnectionErrorCodes.ReadOnly,
					"This datasource is read-only",
				);
			}
			try {
				return await adapter.mutateTable(
					resolved,
					{
						schema: request.schema,
						table: request.table,
						edits: request.edits,
					},
					tableLimits,
				);
			} catch (error) {
				throw asServiceError(error);
			}
		},

		async describeObject(workspace, request) {
			const resolved = await resolveConnection(workspace, request.connectionId);
			const adapter = adapters[resolved.adapter];
			if (
				adapter.describeObject === undefined ||
				adapter.capabilities.introspection !== "sql"
			) {
				throw new ServiceError(
					ErrorCodes.BadRequest,
					`Connection '${request.connectionId}' has no object view`,
				);
			}
			try {
				return await adapter.describeObject(
					resolved,
					{
						schema: request.schema,
						name: request.name,
						kind: request.kind,
					},
					tableLimits,
				);
			} catch (error) {
				throw asServiceError(error);
			}
		},

		async alterColumns(workspace, request) {
			const resolved = await resolveConnection(workspace, request.connectionId);
			const adapter = adapters[resolved.adapter];
			if (adapter.alterColumns === undefined) {
				throw new ServiceError(
					ErrorCodes.BadRequest,
					`Connection '${request.connectionId}' cannot change columns`,
				);
			}
			// A preview is a read: it builds SQL and runs none of it, so the
			// read-only check belongs to the apply step, not here.
			if (!request.dryRun && resolved.readOnly) {
				throw new ServiceError(
					ConnectionErrorCodes.ReadOnly,
					"This datasource is read-only",
				);
			}
			const unsupported = request.changes.find(
				(change) => !adapter.capabilities.columnChanges.includes(change.type),
			);
			if (unsupported !== undefined) {
				throw new ServiceError(
					ErrorCodes.BadRequest,
					`${resolved.adapter} cannot '${unsupported.type}' a column`,
				);
			}
			try {
				return await adapter.alterColumns(
					resolved,
					{
						schema: request.schema,
						name: request.name,
						changes: request.changes,
						dryRun: request.dryRun,
					},
					tableLimits,
				);
			} catch (error) {
				throw asServiceError(error);
			}
		},

		async schemaChildren(workspace, connectionId, path, refresh) {
			const cacheKey = `${workspace.id}:${connectionId}:${JSON.stringify(path)}`;
			const cached = introspectionCache.get(cacheKey);
			if (!refresh && cached !== undefined && cached.expiresAt > Date.now()) {
				return cached.nodes;
			}
			const resolved = await resolveConnection(workspace, connectionId);
			const nodes = await adapters[resolved.adapter].introspectChildren(
				resolved,
				path,
			);
			introspectionCache.set(cacheKey, {
				expiresAt: Date.now() + cacheTtl,
				nodes,
			});
			return nodes;
		},
	};
}
