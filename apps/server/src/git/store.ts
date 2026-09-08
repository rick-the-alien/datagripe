import type { AppDb } from "../db/app/pool";

/**
 * The `git_datasources` rows (docs/spec/git-datasources.md "Storage").
 *
 * A pointer, not a copy: nothing out of `.datagripe/config.yaml` is
 * denormalised here, because then there would be two answers to what
 * the datasource is and one of them would be stale.
 */

export interface GitDatasourceRow {
	id: string;
	repo_path: string;
	remote_url: string | null;
	managed_clone: boolean;
	created_at: Date;
}

/** `ConnectionMetadata.id` for a git datasource. */
export const GIT_REF_PREFIX = "git:";

export function refFor(id: string): string {
	return `${GIT_REF_PREFIX}${id}`;
}

/**
 * The uuid inside a `git:<uuid>` ref, or null when the ref is not one.
 * Nothing branches on id *shape* anywhere: managed ids are bare uuids,
 * predefined ids are slugs, and git ids carry their prefix.
 */
export function idFromRef(ref: string): string | null {
	if (!ref.startsWith(GIT_REF_PREFIX)) {
		return null;
	}
	const id = ref.slice(GIT_REF_PREFIX.length);
	return /^[0-9a-f-]{36}$/i.test(id) ? id : null;
}

export async function listRows(
	appDb: AppDb,
	workspaceId: string,
): Promise<GitDatasourceRow[]> {
	return appDb<GitDatasourceRow[]>`
		SELECT id, repo_path, remote_url, managed_clone, created_at
		FROM git_datasources
		WHERE workspace_id = ${workspaceId}
		ORDER BY created_at
	`;
}

export async function findRow(
	appDb: AppDb,
	workspaceId: string,
	id: string,
): Promise<GitDatasourceRow | null> {
	const rows = await appDb<GitDatasourceRow[]>`
		SELECT id, repo_path, remote_url, managed_clone, created_at
		FROM git_datasources
		WHERE workspace_id = ${workspaceId} AND id = ${id}
	`;
	return rows[0] ?? null;
}

export async function insertRow(
	appDb: AppDb,
	workspaceId: string,
	repoPath: string,
	remoteUrl: string | null,
	managedClone: boolean,
	createdBy: string | null,
): Promise<GitDatasourceRow> {
	const rows = await appDb<GitDatasourceRow[]>`
		INSERT INTO git_datasources
			(workspace_id, repo_path, remote_url, managed_clone, created_by)
		VALUES (${workspaceId}, ${repoPath}, ${remoteUrl}, ${managedClone}, ${createdBy})
		RETURNING id, repo_path, remote_url, managed_clone, created_at
	`;
	const row = rows[0];
	if (row === undefined) {
		throw new Error("git_datasources insert returned no row");
	}
	return row;
}

export async function deleteRow(
	appDb: AppDb,
	workspaceId: string,
	id: string,
): Promise<void> {
	await appDb`
		DELETE FROM git_datasources
		WHERE workspace_id = ${workspaceId} AND id = ${id}
	`;
}

export interface StoredSecret {
	ciphertext: Buffer;
	key_version: number;
}

export async function findSecret(
	appDb: AppDb,
	datasourceId: string,
): Promise<StoredSecret | null> {
	const rows = await appDb<StoredSecret[]>`
		SELECT ciphertext, key_version FROM git_datasource_secrets
		WHERE datasource_id = ${datasourceId}
	`;
	return rows[0] ?? null;
}

export async function upsertSecret(
	appDb: AppDb,
	datasourceId: string,
	ciphertext: Buffer,
	keyVersion: number,
): Promise<void> {
	await appDb`
		INSERT INTO git_datasource_secrets
			(datasource_id, ciphertext, key_version)
		VALUES (${datasourceId}, ${ciphertext}, ${keyVersion})
		ON CONFLICT (datasource_id) DO UPDATE
			SET ciphertext = EXCLUDED.ciphertext,
				key_version = EXCLUDED.key_version,
				updated_at = now()
	`;
}
