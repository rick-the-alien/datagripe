import type { DatasourcePath } from "@datagripe/contracts";
import type { AppDb } from "../db/app/pool";

/**
 * Datasource path storage — the (name, directory) pairs a datasource
 * carries (docs/spec/datasource-paths.md).
 *
 * Queries only, and deliberately free of `ServiceError`: `listConnections`
 * reads these to build `ConnectionMetadata.paths`, and `ServiceError`
 * lives in the connections service, so importing it here would close an
 * import cycle. The validating half is `service.ts`.
 */

export type PathRow = {
	id: string;
	connection_ref: string;
	name: string;
	path: string;
};

export function rowToPath(row: PathRow): DatasourcePath {
	return { id: row.id, name: row.name, path: row.path };
}

export async function listDatasourcePaths(
	appDb: AppDb,
	workspaceId: string,
	connectionRef: string,
): Promise<DatasourcePath[]> {
	const rows = await appDb<PathRow[]>`
		SELECT id, connection_ref, name, path FROM datasource_paths
		WHERE workspace_id = ${workspaceId} AND connection_ref = ${connectionRef}
		ORDER BY position, name
	`;
	return rows.map(rowToPath);
}

/** Every datasource's paths in one query, for `listConnections`. */
export async function datasourcePathsByConnection(
	appDb: AppDb,
	workspaceId: string,
): Promise<Map<string, DatasourcePath[]>> {
	const rows = await appDb<PathRow[]>`
		SELECT id, connection_ref, name, path FROM datasource_paths
		WHERE workspace_id = ${workspaceId}
		ORDER BY position, name
	`;
	const byRef = new Map<string, DatasourcePath[]>();
	for (const row of rows) {
		const list = byRef.get(row.connection_ref) ?? [];
		list.push(rowToPath(row));
		byRef.set(row.connection_ref, list);
	}
	return byRef;
}

/** One path by id; null when it was removed while a tab still held it. */
export async function findDatasourcePath(
	appDb: AppDb,
	workspaceId: string,
	pathId: string,
): Promise<(DatasourcePath & { connectionRef: string }) | null> {
	const rows = await appDb<PathRow[]>`
		SELECT id, connection_ref, name, path FROM datasource_paths
		WHERE workspace_id = ${workspaceId} AND id = ${pathId}
	`;
	const row = rows[0];
	return row === undefined
		? null
		: { ...rowToPath(row), connectionRef: row.connection_ref };
}
