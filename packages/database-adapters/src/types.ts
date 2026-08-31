import type {
	ConnectionTestResult,
	SchemaNode,
	SchemaPathSegment,
} from "@datagripe/contracts";

/**
 * A connection with its secret resolved in server memory, immediately
 * before use. Adapters never see ciphertext and never persist this.
 */
export interface ResolvedConnection {
	adapter: "postgres";
	host: string;
	port: number;
	database: string;
	username: string;
	password: string;
	tlsMode: "disable" | "require" | "verify-full";
	readOnly: boolean;
}

/**
 * Target-database adapter boundary (docs/initial_idea.md §6). Phase 2
 * covers connection testing and lazy introspection; execution arrives in
 * Phase 3 with its own request/handle types.
 */
export interface DatabaseAdapter {
	readonly adapterId: "postgres";
	testConnection(connection: ResolvedConnection): Promise<ConnectionTestResult>;
	introspectChildren(
		connection: ResolvedConnection,
		path: SchemaPathSegment[],
	): Promise<SchemaNode[]>;
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
