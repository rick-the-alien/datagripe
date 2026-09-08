import type { DomainRun, ExportPlan } from "@datagripe/contracts";
import type { AppDb } from "../db/app/pool";

/**
 * Export run history (docs/spec/domains.md "Run history").
 *
 * Server-side rather than parsed back out of `pull.log`, because it is
 * attributable, queryable and survives the working tree being cleaned.
 * `pull.log` still gets a line — it travels in the repository for people
 * reading the dump without DataGripe — and it is derived from this row.
 */

type RunRow = {
	id: string;
	started_at: string;
	finished_at: string | null;
	actor_email: string | null;
	domain_count: number;
	object_count: number;
	written: number;
	deleted: number;
	refused: number;
	outcome: DomainRun["outcome"];
	error: string | null;
	commit_sha: string | null;
};

function rowToRun(row: RunRow): DomainRun {
	return {
		id: row.id,
		startedAt: new Date(row.started_at).toISOString(),
		finishedAt:
			row.finished_at === null ? null : new Date(row.finished_at).toISOString(),
		actorEmail: row.actor_email,
		domainCount: row.domain_count,
		objectCount: row.object_count,
		written: row.written,
		deleted: row.deleted,
		refused: row.refused,
		outcome: row.outcome,
		error: row.error,
		commitSha: row.commit_sha,
	};
}

export async function listRuns(
	appDb: AppDb,
	workspaceId: string,
	connectionRef: string,
	limit: number,
): Promise<DomainRun[]> {
	const rows = await appDb<RunRow[]>`
		SELECT e.id, e.started_at, e.finished_at, u.email AS actor_email,
			e.domain_count, e.object_count, e.written, e.deleted, e.refused,
			e.outcome, e.error, e.commit_sha
		FROM domain_exports e
		LEFT JOIN users u ON u.id = e.actor
		WHERE e.workspace_id = ${workspaceId} AND e.connection_ref = ${connectionRef}
		ORDER BY e.started_at DESC
		LIMIT ${limit}
	`;
	return rows.map(rowToRun);
}

/**
 * Record a finished run. A dry run never gets here — it did nothing, and
 * a history full of previews is a history nobody reads.
 */
export async function recordRun(
	appDb: AppDb,
	workspaceId: string,
	connectionRef: string,
	actor: string,
	outcome: DomainRun["outcome"],
	plan: ExportPlan | null,
	error: string | null,
): Promise<string> {
	const rows = await appDb<Array<{ id: string }>>`
		INSERT INTO domain_exports
			(workspace_id, connection_ref, actor, finished_at, domain_count,
			 object_count, written, deleted, refused, outcome, error)
		VALUES (${workspaceId}, ${connectionRef}, ${actor}, now(),
			${plan?.domainCount ?? 0}, ${plan?.objectCount ?? 0},
			${plan?.written ?? 0}, ${plan?.deleted ?? 0}, ${plan?.refused ?? 0},
			${outcome}, ${error})
		RETURNING id
	`;
	return rows[0]?.id ?? "";
}

/** Attach a commit sha to the run it committed. */
export async function attachCommit(
	appDb: AppDb,
	workspaceId: string,
	runId: string,
	commitSha: string,
): Promise<void> {
	await appDb`
		UPDATE domain_exports SET commit_sha = ${commitSha}
		WHERE id = ${runId} AND workspace_id = ${workspaceId}
	`;
}

/**
 * The export directory for one datasource in one workspace
 * (migration 0012). Per datasource, not per workspace: an export never
 * crosses a datasource boundary, so one path per project would have two
 * datasources overwriting each other's tree.
 */
export async function exportPath(
	appDb: AppDb,
	workspaceId: string,
	connectionRef: string,
): Promise<string | null> {
	const rows = await appDb<Array<{ path: string }>>`
		SELECT path FROM datasource_export_paths
		WHERE workspace_id = ${workspaceId} AND connection_ref = ${connectionRef}
	`;
	return rows[0]?.path ?? null;
}

/** An empty or absent value clears it, rather than storing a blank. */
export async function setExportPath(
	appDb: AppDb,
	workspaceId: string,
	connectionRef: string,
	value: string | null,
): Promise<void> {
	const trimmed = value?.trim() ?? "";
	if (trimmed === "") {
		await appDb`
			DELETE FROM datasource_export_paths
			WHERE workspace_id = ${workspaceId} AND connection_ref = ${connectionRef}
		`;
		return;
	}
	await appDb`
		INSERT INTO datasource_export_paths (workspace_id, connection_ref, path)
		VALUES (${workspaceId}, ${connectionRef}, ${trimmed})
		ON CONFLICT (workspace_id, connection_ref)
		DO UPDATE SET path = EXCLUDED.path
	`;
}

/** Paths for every datasource in a workspace, for `listConnections`. */
export async function exportPaths(
	appDb: AppDb,
	workspaceId: string,
): Promise<Map<string, string>> {
	const rows = await appDb<Array<{ connection_ref: string; path: string }>>`
		SELECT connection_ref, path FROM datasource_export_paths
		WHERE workspace_id = ${workspaceId}
	`;
	return new Map(rows.map((row) => [row.connection_ref, row.path]));
}
