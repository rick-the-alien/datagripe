import type { Dismissal, DismissRequest } from "@datagripe/contracts";
import type { AppDb } from "../db/app/pool";
import { log } from "../log";

/**
 * Gripe dismissals (docs/spec/gripes.md "Dismissal").
 *
 * Team-wide per workspace: a schema finding is a team fact, and a
 * dismissal that silenced only one member's panel would have every
 * member dismiss the same thing. The spec records this as an open
 * question, so `dismissed_by` is stored against every row — enough to
 * make it personal later without losing history.
 */

type DismissalRow = {
	rule_id: string;
	scope: Dismissal["scope"];
	key: string;
};

function rowToDismissal(row: DismissalRow): Dismissal {
	return {
		ruleId: row.rule_id,
		scope: row.scope,
		// `project` has no key; the column stores '' so one unique index
		// covers every scope.
		key: row.key === "" ? null : row.key,
	};
}

export async function listDismissals(
	appDb: AppDb,
	workspaceId: string,
): Promise<Dismissal[]> {
	const rows = await appDb<DismissalRow[]>`
		SELECT rule_id, scope, key
		FROM gripe_dismissals
		WHERE workspace_id = ${workspaceId}
		ORDER BY rule_id, scope
	`;
	return rows.map(rowToDismissal);
}

export async function dismiss(
	appDb: AppDb,
	workspaceId: string,
	userId: string,
	request: DismissRequest,
): Promise<Dismissal[]> {
	const key = request.scope === "project" ? "" : (request.key ?? "");
	await appDb`
		INSERT INTO gripe_dismissals (workspace_id, rule_id, scope, key, dismissed_by)
		VALUES (${workspaceId}, ${request.ruleId}, ${request.scope}, ${key}, ${userId})
		ON CONFLICT (workspace_id, rule_id, scope, key) DO NOTHING
	`;
	log.info("audit", {
		event: "gripe.dismiss",
		workspaceId,
		userId,
		ruleId: request.ruleId,
		scope: request.scope,
	});
	return listDismissals(appDb, workspaceId);
}

export async function restore(
	appDb: AppDb,
	workspaceId: string,
	userId: string,
	request: Dismissal,
): Promise<Dismissal[]> {
	const key = request.scope === "project" ? "" : (request.key ?? "");
	await appDb`
		DELETE FROM gripe_dismissals
		WHERE workspace_id = ${workspaceId}
			AND rule_id = ${request.ruleId}
			AND scope = ${request.scope}
			AND key = ${key}
	`;
	log.info("audit", {
		event: "gripe.restore",
		workspaceId,
		userId,
		ruleId: request.ruleId,
		scope: request.scope,
	});
	return listDismissals(appDb, workspaceId);
}

/** Bring back everything, which is the panel's "show hidden" escape. */
export async function restoreAll(
	appDb: AppDb,
	workspaceId: string,
	userId: string,
): Promise<Dismissal[]> {
	await appDb`DELETE FROM gripe_dismissals WHERE workspace_id = ${workspaceId}`;
	log.info("audit", { event: "gripe.restore-all", workspaceId, userId });
	return listDismissals(appDb, workspaceId);
}
