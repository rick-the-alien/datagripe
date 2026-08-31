import type { AppDb } from "./db/app/pool";

/**
 * Pre-authentication stub (Phase 4 replaces this with real session
 * identity): a single local user and "Local" workspace so the workspace-
 * scoped tables have an owner. Idempotent.
 */
export async function ensureLocalWorkspace(
	appDb: AppDb,
): Promise<{ id: string; name: string }> {
	const email = "local@datagripe.local";
	const name = "Local";

	await appDb`
		INSERT INTO users (email) VALUES (${email})
		ON CONFLICT (email) DO NOTHING
	`;
	const users = await appDb<{ id: string }[]>`
		SELECT id FROM users WHERE email = ${email}
	`;
	const user = users[0];
	if (user === undefined) {
		throw new Error("Failed to bootstrap local user");
	}

	const existing = await appDb<{ id: string; name: string }[]>`
		SELECT id, name FROM workspaces WHERE owner_id = ${user.id} AND name = ${name}
	`;
	const workspace = existing[0];
	if (workspace !== undefined) {
		return workspace;
	}

	const created = await appDb<{ id: string; name: string }[]>`
		INSERT INTO workspaces (owner_id, name) VALUES (${user.id}, ${name})
		RETURNING id, name
	`;
	const row = created[0];
	if (row === undefined) {
		throw new Error("Failed to bootstrap local workspace");
	}
	return row;
}
