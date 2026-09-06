import { z } from "zod";

/**
 * Adapter capabilities (roadmap Phase 5 exit criterion): the UI and the
 * dispatcher gate behavior on these flags, never on the adapter id.
 * Adding an adapter means adding its implementation and one entry here.
 */

export const connectionAdapterSchema = z.enum([
	"postgres",
	"mysql",
	"sqlite",
	"redis",
]);

export type ConnectionAdapter = z.infer<typeof connectionAdapterSchema>;

/** Fields the connection dialog renders for an adapter. */
export type AdapterField =
	| "host"
	| "port"
	| "database"
	| "username"
	| "password"
	| "tlsMode"
	| "readOnly";

export interface AdapterCapabilities {
	/**
	 * "sql": schema/tables/views/columns tree.
	 * "keyspace": key/prefix browser (Redis).
	 * null: no explorer.
	 */
	introspection: "sql" | "keyspace" | null;
	/**
	 * "cursor": server-side cursor streaming (PostgreSQL).
	 * "buffered": full result fetch, truncated to caps (MySQL, SQLite).
	 * null: no SQL execution.
	 */
	execution: "cursor" | "buffered" | null;
	/** True when cancellation interrupts the running statement server-side. */
	cancellation: boolean;
	/**
	 * Table view support (docs/spec/table-view.md).
	 * "readwrite": browse rows and write single-row edits back.
	 * "read": browse only.
	 * null: no table view.
	 */
	tableData: "readwrite" | "read" | null;
	defaultPort: number | null;
	fields: AdapterField[];
	/** Dialog label for the `database` field (database name, file path, db index). */
	databaseLabel: string;
}

export const ADAPTER_CAPABILITIES: Record<
	ConnectionAdapter,
	AdapterCapabilities
> = {
	postgres: {
		introspection: "sql",
		execution: "cursor",
		cancellation: true,
		tableData: "readwrite",
		defaultPort: 5432,
		fields: [
			"host",
			"port",
			"database",
			"username",
			"password",
			"tlsMode",
			"readOnly",
		],
		databaseLabel: "Database",
	},
	mysql: {
		introspection: "sql",
		execution: "buffered",
		cancellation: true,
		tableData: "readwrite",
		defaultPort: 3306,
		fields: [
			"host",
			"port",
			"database",
			"username",
			"password",
			"tlsMode",
			"readOnly",
		],
		databaseLabel: "Database",
	},
	sqlite: {
		introspection: "sql",
		execution: "buffered",
		cancellation: false,
		tableData: "readwrite",
		defaultPort: null,
		fields: ["database", "readOnly"],
		databaseLabel: "File path",
	},
	redis: {
		introspection: "keyspace",
		execution: null,
		cancellation: false,
		tableData: null,
		defaultPort: 6379,
		fields: ["host", "port", "database", "password", "tlsMode", "readOnly"],
		databaseLabel: "DB index",
	},
};

/** Capabilities advertised to the client inside workspace.open so the
 * UI never branches on adapter ids. */
export const adapterInfoSchema = z.object({
	adapter: connectionAdapterSchema,
	introspection: z.enum(["sql", "keyspace"]).nullable(),
	execution: z.enum(["cursor", "buffered"]).nullable(),
	cancellation: z.boolean(),
	tableData: z.enum(["readwrite", "read"]).nullable(),
	defaultPort: z.number().nullable(),
	fields: z.array(z.string()),
	databaseLabel: z.string(),
});

export type AdapterInfo = z.infer<typeof adapterInfoSchema>;

export function adapterInfoOf(
	adapter: ConnectionAdapter,
	capabilities: AdapterCapabilities,
): AdapterInfo {
	return {
		adapter,
		introspection: capabilities.introspection,
		execution: capabilities.execution,
		cancellation: capabilities.cancellation,
		tableData: capabilities.tableData,
		defaultPort: capabilities.defaultPort,
		fields: capabilities.fields,
		databaseLabel: capabilities.databaseLabel,
	};
}
