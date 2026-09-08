import type {
	DatasourcePath,
	DatasourcePathsSetRequest,
} from "@datagripe/contracts";
import { ErrorCodes } from "@datagripe/contracts/errors";
import { ServiceError } from "../connections/service";
import type { AppDb } from "../db/app/pool";
import { findDatasourcePath, type PathRow, rowToPath } from "./store";

/**
 * Datasource paths — the validating half (docs/spec/datasource-paths.md).
 * The plain queries live in `store.ts`; what may be read or written under
 * a path lives in `browse.ts`, behind the same host-filesystem gate the
 * domain export goes through.
 */

/** `findDatasourcePath`, for the callers that cannot carry on without it. */
export async function getDatasourcePath(
	appDb: AppDb,
	workspaceId: string,
	pathId: string,
): Promise<DatasourcePath & { connectionRef: string }> {
	const found = await findDatasourcePath(appDb, workspaceId, pathId);
	if (found === null) {
		throw new ServiceError(
			ErrorCodes.NotFound,
			"That datasource path no longer exists",
		);
	}
	return found;
}

/**
 * Replace one datasource's whole list.
 *
 * Rows the request kept are updated in place, so a renamed section keeps
 * its id — and with it every file already open from it. Rows it dropped
 * take their open documents with them, but by *archiving* them rather
 * than deleting: removing a path pair is a sidebar decision, and it must
 * not be able to destroy a member's unsaved work. The files on disk are
 * never touched either way.
 */
export async function setDatasourcePaths(
	appDb: AppDb,
	workspaceId: string,
	request: DatasourcePathsSetRequest,
): Promise<DatasourcePath[]> {
	const seen = new Set<string>();
	for (const entry of request.paths) {
		const key = entry.name.trim().toLowerCase();
		if (seen.has(key)) {
			throw new ServiceError(
				ErrorCodes.BadRequest,
				`Two paths are both called '${entry.name.trim()}' — the sidebar could not tell them apart`,
			);
		}
		seen.add(key);
	}

	return appDb.begin(async (tx) => {
		const existing = await tx<Array<{ id: string }>>`
			SELECT id FROM datasource_paths
			WHERE workspace_id = ${workspaceId}
				AND connection_ref = ${request.connectionRef}
		`;
		const keptIds = new Set(
			request.paths
				.map((entry) => entry.id)
				.filter((id): id is string => id !== undefined),
		);
		const removed = existing
			.map((row) => row.id)
			.filter((id) => !keptIds.has(id));

		// One statement per removed row rather than an array parameter: the
		// list is capped at twenty, and `= ANY($1::uuid[])` needs an array
		// literal the driver does not build from a JS array.
		for (const id of removed) {
			await tx`
				DELETE FROM datasource_paths
				WHERE workspace_id = ${workspaceId} AND id = ${id}
			`;
			await tx`
				UPDATE documents SET archived_at = now()
				WHERE workspace_id = ${workspaceId}
					AND origin_path_id = ${id}
					AND archived_at IS NULL
			`;
		}

		let position = 0;
		for (const entry of request.paths) {
			const name = entry.name.trim();
			const value = entry.path.trim();
			if (entry.id === undefined) {
				await tx`
					INSERT INTO datasource_paths
						(workspace_id, connection_ref, name, path, position)
					VALUES (${workspaceId}, ${request.connectionRef}, ${name}, ${value}, ${position})
				`;
			} else {
				// Scoped to the workspace *and* the datasource: an id from
				// another datasource must not be re-pointed by sending it here.
				const updated = await tx<Array<{ id: string }>>`
					UPDATE datasource_paths
					SET name = ${name}, path = ${value}, position = ${position}
					WHERE workspace_id = ${workspaceId}
						AND connection_ref = ${request.connectionRef}
						AND id = ${entry.id}
					RETURNING id
				`;
				if (updated.length === 0) {
					throw new ServiceError(
						ErrorCodes.NotFound,
						"One of those paths no longer exists — reopen the datasource page",
					);
				}
			}
			position += 1;
		}

		const rows = await tx<PathRow[]>`
			SELECT id, connection_ref, name, path FROM datasource_paths
			WHERE workspace_id = ${workspaceId}
				AND connection_ref = ${request.connectionRef}
			ORDER BY position, name
		`;
		return rows.map(rowToPath);
	});
}
