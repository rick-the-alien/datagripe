import { SQL } from "bun";
import type { AppConfig } from "../../config";

/**
 * The single application-owned pool. This client is ONLY for DataGripe's
 * own database — never use it to execute editor SQL against target
 * databases (see db/targets for that boundary).
 */
export function createAppDb(config: AppConfig): SQL {
	return new SQL(config.APP_DATABASE_URL, {
		max: 10,
		idleTimeout: 30,
		connectionTimeout: 10,
	});
}

/** The application database handle. Consumers import this named type. */
export type { SQL as AppDb } from "bun";
