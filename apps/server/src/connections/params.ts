import type { ConnectionParams } from "@datagripe/contracts";
import type { AppDb } from "../db/app/pool";

/**
 * Runtime parameter storage — the PostgreSQL settings a managed
 * datasource sends in its startup packet (`connectionParams.ts`).
 *
 * A child of `connections` rather than a `(workspace_id, connection_ref)`
 * table like `datasource_paths`, because these are part of the
 * datasource's *definition* and not workspace-local configuration about
 * it: `search_path` changes what a query means. A predefined datasource
 * therefore carries them in `connections.json` and a git one in
 * `config.yaml`; rows keyed by ref for those would be rows nobody reads.
 *
 * Queries only, and free of `ServiceError` for the same reason
 * `files/store.ts` is: `listConnections` reads these, and the error type
 * lives in the service that calls it.
 */

type ParamRow = {
	connection_id: string;
	name: string;
	value: string;
};

function collect(rows: ParamRow[]): ConnectionParams {
	const params: Record<string, string> = {};
	for (const row of rows) {
		params[row.name] = row.value;
	}
	return params;
}

export async function listConnectionParams(
	appDb: AppDb,
	connectionId: string,
): Promise<ConnectionParams> {
	const rows = await appDb<ParamRow[]>`
		SELECT connection_id, name, value FROM connection_params
		WHERE connection_id = ${connectionId}
		ORDER BY name
	`;
	return collect(rows);
}

/** Every managed datasource's parameters in one query, for `listConnections`. */
export async function connectionParamsByConnection(
	appDb: AppDb,
	workspaceId: string,
): Promise<Map<string, ConnectionParams>> {
	const rows = await appDb<ParamRow[]>`
		SELECT p.connection_id, p.name, p.value
		FROM connection_params p
		JOIN connections c ON c.id = p.connection_id
		WHERE c.workspace_id = ${workspaceId}
		ORDER BY p.name
	`;
	const byId = new Map<string, ConnectionParams>();
	for (const row of rows) {
		const params = byId.get(row.connection_id) ?? {};
		params[row.name] = row.value;
		byId.set(row.connection_id, params);
	}
	return byId;
}

/**
 * Replace a datasource's whole parameter set. A record has no partial
 * update worth the ambiguity — "set these and leave the rest" makes
 * removing one impossible without a second verb.
 *
 * Takes the transaction rather than the pool: the rows belong to the
 * connection, and a create that wrote the row and then failed to write
 * its parameters would leave a datasource nobody asked for.
 */
export async function replaceConnectionParams(
	tx: AppDb,
	connectionId: string,
	params: ConnectionParams,
): Promise<void> {
	await tx`DELETE FROM connection_params WHERE connection_id = ${connectionId}`;
	for (const [name, value] of Object.entries(params)) {
		await tx`
			INSERT INTO connection_params (connection_id, name, value)
			VALUES (${connectionId}, ${name}, ${value})
		`;
	}
}
