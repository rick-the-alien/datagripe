import type { WorkspaceListEntry } from "@datagripe/contracts";
import { ErrorCodes } from "@datagripe/contracts/errors";
import { ServiceError } from "../connections/service";
import type { AppDb } from "../db/app/pool";
import { log } from "../log";

/** Workspace lifecycle (workspaces are the project unit). */

export async function createWorkspace(
	appDb: AppDb,
	userId: string,
	name: string,
): Promise<WorkspaceListEntry> {
	return appDb.begin(async (tx) => {
		const rows = await tx<{ id: string }[]>`
			INSERT INTO workspaces (owner_id, name) VALUES (${userId}, ${name})
			RETURNING id
		`;
		const workspace = rows[0];
		if (workspace === undefined) {
			throw new ServiceError(ErrorCodes.Internal, "Insert returned no row");
		}
		await tx`
			INSERT INTO workspace_members (workspace_id, user_id, role)
			VALUES (${workspace.id}, ${userId}, 'owner')
		`;
		log.audit("workspace.create", { workspaceId: workspace.id, userId });
		return { id: workspace.id, name, role: "owner" };
	});
}

export async function listWorkspaces(
	appDb: AppDb,
	userId: string,
): Promise<WorkspaceListEntry[]> {
	const rows = await appDb<
		Array<{ id: string; name: string; role: "owner" | "editor" | "viewer" }>
	>`
		SELECT w.id, w.name, m.role
		FROM workspace_members m
		JOIN workspaces w ON w.id = m.workspace_id
		WHERE m.user_id = ${userId}
		ORDER BY w.created_at
	`;
	return rows;
}

export async function setDefaultConnection(
	appDb: AppDb,
	workspaceId: string,
	connectionRef: string | null,
	isKnownRef: (ref: string) => Promise<boolean>,
): Promise<void> {
	if (connectionRef !== null && !(await isKnownRef(connectionRef))) {
		throw new ServiceError(
			ErrorCodes.NotFound,
			`Connection '${connectionRef}' not found in this workspace`,
		);
	}
	await appDb`
		UPDATE workspaces SET default_connection_ref = ${connectionRef}
		WHERE id = ${workspaceId}
	`;
	log.audit("workspace.set-default-connection", {
		workspaceId,
		connectionRef,
	});
}
