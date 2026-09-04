import { SQL } from "bun";

/**
 * The single application-owned pool. This client is ONLY for DataGripe's
 * own database — never use it to execute editor SQL against target
 * databases (see db/targets for that boundary). The URL comes from
 * APP_DATABASE_URL (external mode) or the embedded cluster started at
 * boot (embedded mode).
 */
export function createAppDb(databaseUrl: string): SQL {
	return new SQL(databaseUrl, {
		max: 10,
		idleTimeout: 30,
		connectionTimeout: 10,
	});
}

/** The application database handle. Consumers import this named type. */
export type { SQL as AppDb } from "bun";
