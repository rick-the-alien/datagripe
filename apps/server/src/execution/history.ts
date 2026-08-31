import type { HistoryListResult } from "@datagripe/contracts";
import type { AppDb } from "../db/app/pool";

/** Paginated query history metadata, newest first. */
export async function listHistory(
	appDb: AppDb,
	userId: string,
	workspaceId: string,
	limit: number,
	offset: number,
	scope: "mine" | "workspace",
	predefinedName: (id: string) => string | undefined = () => undefined,
): Promise<HistoryListResult> {
	type Row = {
		id: string;
		connection_id: string | null;
		connection_ref: string | null;
		connection_name: string | null;
		actor_email: string | null;
		document_id: string | null;
		status: "queued" | "running" | "succeeded" | "failed" | "cancelled";
		preview: string;
		started_at: string | null;
		finished_at: string | null;
		row_count: string | number | null;
		truncated: boolean | null;
		error_code: string | null;
	};
	const scopeFilter =
		scope === "mine"
			? appDb`WHERE q.user_id = ${userId}`
			: appDb`WHERE q.user_id IN (
				SELECT user_id FROM workspace_members WHERE workspace_id = ${workspaceId}
			)`;
	const rows = await appDb<Row[]>`
		SELECT
			q.id, q.connection_id, q.connection_ref,
			coalesce(c.name, q.connection_ref, 'unknown') AS connection_name,
			u.email AS actor_email,
			q.document_id, q.status, q.preview,
			q.started_at, q.finished_at, q.row_count, q.truncated, q.error_code
		FROM query_executions q
		LEFT JOIN connections c ON c.id = q.connection_id
		LEFT JOIN users u ON u.id = q.user_id
		${scopeFilter}
		ORDER BY q.created_at DESC
		LIMIT ${limit} OFFSET ${offset}
	`;
	const totals = await appDb<{ total: string | number }[]>`
		SELECT count(*) AS total FROM query_executions q
		${scopeFilter}
	`;
	return {
		entries: rows.map((row) => {
			const ref = row.connection_ref;
			const predefinedDisplay = ref?.startsWith("predefined:")
				? predefinedName(ref.slice("predefined:".length))
				: undefined;
			return {
				id: row.id,
				connectionId: row.connection_id ?? row.connection_ref ?? "unknown",
				connectionName: predefinedDisplay ?? row.connection_name ?? "unknown",
				actorEmail: row.actor_email ?? "unknown",
				documentId: row.document_id,
				status: row.status,
				preview: row.preview,
				startedAt: row.started_at,
				finishedAt: row.finished_at,
				rowCount: row.row_count === null ? null : Number(row.row_count),
				truncated: row.truncated,
				errorCode: row.error_code,
			};
		}),
		total: Number(totals[0]?.total ?? 0),
	};
}
