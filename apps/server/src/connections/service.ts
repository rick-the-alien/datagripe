import type {
	ConnectionCreateRequest,
	ConnectionMetadata,
	ConnectionTestRequest,
	ConnectionTestResult,
	ConnectionUpdateRequest,
	SchemaNode,
	SchemaPathSegment,
} from "@datagripe/contracts";
import { ErrorCodes } from "@datagripe/contracts/errors";
import type {
	DatabaseAdapter,
	ResolvedConnection,
} from "@datagripe/database-adapters";
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
	adapter: "postgres";
	host: string;
	port: number;
	database_name: string;
	username: string;
	tls_mode: "disable" | "require" | "verify-full";
	read_only: boolean;
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
	adapter: DatabaseAdapter;
	predefined: ReadonlyMap<string, PredefinedEntry>;
	ssrf: SsrfPolicy;
	/** Introspection cache TTL in ms (default 30s). */
	introspectionCacheTtlMs?: number;
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
		source: "managed",
		createdAt: row.created_at,
		updatedAt: row.updated_at,
	};
}

export function createConnectionsService(
	deps: ConnectionsServiceDeps,
): ConnectionsService {
	const { appDb, keyring, adapter, predefined, ssrf } = deps;
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
			host: definition.host,
			port: definition.port,
			databaseName: definition.database,
			username: definition.username,
			tlsMode: definition.tlsMode,
			readOnly: definition.readOnly,
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

	async function resolveConnection(
		workspace: WorkspaceRef,
		id: string,
	): Promise<ResolvedConnection> {
		const entry = predefined.get(id);
		if (entry !== undefined) {
			await guardHost(entry.resolved.host);
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
		await guardHost(row.host);
		return {
			adapter: row.adapter,
			host: row.host,
			port: row.port,
			database: row.database_name,
			username: row.username,
			password: keyring.decrypt(row.ciphertext, row.key_version),
			tlsMode: row.tls_mode,
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
			await guardHost(request.host);
			const secret = keyring.encrypt(request.password);
			const rows = await appDb.begin(async (tx) => {
				const inserted = await tx<ConnectionRow[]>`
					INSERT INTO connections (
						workspace_id, name, adapter, host, port,
						database_name, username, tls_mode, read_only
					) VALUES (
						${workspace.id}, ${request.name}, ${request.adapter},
						${request.host}, ${request.port}, ${request.databaseName},
						${request.username}, ${request.tlsMode}, ${request.readOnly}
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
				await guardHost(request.draft.host);
				resolved = {
					adapter: request.draft.adapter,
					host: request.draft.host,
					port: request.draft.port,
					database: request.draft.databaseName,
					username: request.draft.username,
					password: request.draft.password,
					tlsMode: request.draft.tlsMode,
					readOnly: request.draft.readOnly,
				};
			}
			return adapter.testConnection(resolved);
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

		async schemaChildren(workspace, connectionId, path, refresh) {
			const cacheKey = `${workspace.id}:${connectionId}:${JSON.stringify(path)}`;
			const cached = introspectionCache.get(cacheKey);
			if (!refresh && cached !== undefined && cached.expiresAt > Date.now()) {
				return cached.nodes;
			}
			const resolved = await resolveConnection(workspace, connectionId);
			const nodes = await adapter.introspectChildren(resolved, path);
			introspectionCache.set(cacheKey, {
				expiresAt: Date.now() + cacheTtl,
				nodes,
			});
			return nodes;
		},
	};
}
