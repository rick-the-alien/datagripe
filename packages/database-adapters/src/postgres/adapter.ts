import type {
	ConnectionTestResult,
	SchemaNode,
	SchemaPathSegment,
} from "@datagripe/contracts";
import { SQL } from "bun";
import {
	type DatabaseAdapter,
	type ExecuteLimits,
	type ExecutionSession,
	InvalidIntrospectionPathError,
	type ResolvedConnection,
} from "../types";
import { beginPostgresExecution } from "./execution";

/**
 * PostgreSQL adapter over Bun.SQL. Target clients are pooled per
 * connection fingerprint and closed with the adapter. Secrets live only
 * in the ResolvedConnection handed in by the caller.
 */
export class PostgresAdapter implements DatabaseAdapter {
	readonly adapterId = "postgres" as const;

	private readonly clients = new Map<string, SQL>();

	private clientFor(connection: ResolvedConnection): SQL {
		// The password participates via a fingerprint: changing a connection's
		// password must not silently reuse a stale pooled client, and the raw
		// secret should not be copied into yet another string.
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
				hostname: connection.host,
				port: connection.port,
				database: connection.database,
				username: connection.username,
				password: connection.password,
				tls:
					connection.tlsMode === "disable"
						? false
						: connection.tlsMode === "require"
							? true
							: { rejectUnauthorized: true },
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
			)`SELECT version() AS version`;
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
				WHERE schema_name NOT LIKE 'pg\\_%' ESCAPE '\\'
					AND schema_name <> 'information_schema'
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
			];
		}

		if (
			categorySegment === undefined ||
			(categorySegment.kind !== "tables" && categorySegment.kind !== "views")
		) {
			throw new InvalidIntrospectionPathError(path);
		}

		if (path.length === 2) {
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

	async close(): Promise<void> {
		await Promise.all(
			[...this.clients.values()].map((client) => client.close()),
		);
		this.clients.clear();
	}

	beginExecution(
		connection: ResolvedConnection,
		limits: ExecuteLimits,
	): Promise<ExecutionSession> {
		return beginPostgresExecution(
			this.clientFor(connection),
			connection,
			limits,
		);
	}
}
