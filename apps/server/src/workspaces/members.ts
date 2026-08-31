import type { WorkspaceMember } from "@datagripe/contracts";
import { ErrorCodes } from "@datagripe/contracts/errors";
import { ServiceError } from "../connections/service";
import type { AppDb } from "../db/app/pool";
import { log } from "../log";

/** Workspace membership management (docs/spec/auth-and-hardening.md). */

type MemberRow = {
	user_id: string;
	email: string;
	role: "owner" | "editor" | "viewer";
	since: string | Date;
};

export async function listMembers(
	appDb: AppDb,
	workspaceId: string,
): Promise<WorkspaceMember[]> {
	const rows = await appDb<MemberRow[]>`
		SELECT m.user_id, u.email, m.role, m.created_at AS since
		FROM workspace_members m
		JOIN users u ON u.id = m.user_id
		WHERE m.workspace_id = ${workspaceId}
		ORDER BY m.created_at
	`;
	return rows.map((row) => ({
		userId: row.user_id,
		email: row.email,
		role: row.role,
		since: new Date(row.since).toISOString(),
	}));
}

export async function addMember(
	appDb: AppDb,
	workspaceId: string,
	email: string,
	role: "editor" | "viewer",
): Promise<WorkspaceMember> {
	const users = await appDb<{ id: string; email: string }[]>`
		SELECT id, email FROM users WHERE email = ${email}
	`;
	const user = users[0];
	if (user === undefined) {
		throw new ServiceError(
			ErrorCodes.NotFound,
			`No account with email '${email}'`,
		);
	}
	const existing = await appDb<{ user_id: string }[]>`
		SELECT user_id FROM workspace_members
		WHERE workspace_id = ${workspaceId} AND user_id = ${user.id}
	`;
	if (existing[0] !== undefined) {
		throw new ServiceError(
			ErrorCodes.Conflict,
			`'${email}' is already a member`,
		);
	}
	await appDb`
		INSERT INTO workspace_members (workspace_id, user_id, role)
		VALUES (${workspaceId}, ${user.id}, ${role})
	`;
	log.audit("workspace.member.add", { workspaceId, userId: user.id, role });
	return {
		userId: user.id,
		email: user.email,
		role,
		since: new Date().toISOString(),
	};
}

export async function removeMember(
	appDb: AppDb,
	workspaceId: string,
	userId: string,
): Promise<void> {
	const target = await appDb<{ role: string }[]>`
		SELECT role FROM workspace_members
		WHERE workspace_id = ${workspaceId} AND user_id = ${userId}
	`;
	if (target[0] === undefined) {
		throw new ServiceError(ErrorCodes.NotFound, "Not a workspace member");
	}
	if (target[0].role === "owner") {
		const owners = await appDb<{ count: string | number }[]>`
			SELECT count(*) AS count FROM workspace_members
			WHERE workspace_id = ${workspaceId} AND role = 'owner'
		`;
		if (Number(owners[0]?.count ?? 0) <= 1) {
			throw new ServiceError(
				ErrorCodes.Forbidden,
				"Cannot remove the last workspace owner",
			);
		}
	}
	await appDb`
		DELETE FROM workspace_members
		WHERE workspace_id = ${workspaceId} AND user_id = ${userId}
	`;
	log.audit("workspace.member.remove", { workspaceId, userId });
}
