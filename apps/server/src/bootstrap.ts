import type { AppDb } from "./db/app/pool";

/** Workspace row handed to the direct-in (AUTH_DISABLED) session. */
export interface LocalWorkspace {
	id: string;
	name: string;
	defaultConnectionRef: string | null;
}

/**
 * Pre-authentication stub (Phase 4 replaces this with real session
 * identity): a single local user and "Local" workspace so the workspace-
 * scoped tables have an owner. Also the direct-in identity when the
 * server runs with AUTH_DISABLED. Idempotent.
 */
export async function ensureLocalWorkspace(appDb: AppDb): Promise<{
	workspace: LocalWorkspace;
	user: { id: string; email: string };
}> {
	const email = "local@datagripe.local";
	const name = "Local";
	await appDb`
		INSERT INTO users (email) VALUES (${email})
		ON CONFLICT (email) DO NOTHING
	`;
	const users = await appDb<{ id: string; email: string }[]>`
		SELECT id, email FROM users WHERE email = ${email}
	`;
	const user = users[0];
	if (user === undefined) {
		throw new Error("Failed to bootstrap local user");
	}

	const existing = await appDb<LocalWorkspace[]>`
		SELECT id, name, default_connection_ref AS "defaultConnectionRef"
		FROM workspaces WHERE owner_id = ${user.id} AND name = ${name}
	`;
	const workspace = existing[0];
	if (workspace !== undefined) {
		return { workspace, user };
	}

	const created = await appDb<LocalWorkspace[]>`
		INSERT INTO workspaces (owner_id, name) VALUES (${user.id}, ${name})
		RETURNING id, name, default_connection_ref AS "defaultConnectionRef"
	`;
	const row = created[0];
	if (row === undefined) {
		throw new Error("Failed to bootstrap local workspace");
	}
	return { workspace: row, user };
}
