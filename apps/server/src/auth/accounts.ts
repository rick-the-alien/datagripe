import type { AppDb } from "../db/app/pool";

/**
 * Account helpers: password hashing (bcrypt via Bun.password), email
 * normalization, and the bootstrap/membership rules from ADR 0002.
 */

export const MIN_PASSWORD_LENGTH = 12;

export async function hashPassword(password: string): Promise<string> {
	return Bun.password.hash(password, { algorithm: "bcrypt", cost: 10 });
}

export async function verifyPassword(
	password: string,
	hash: string,
): Promise<boolean> {
	return Bun.password.verify(password, hash);
}

export function normalizeEmail(email: string): string {
	return email.trim().toLowerCase();
}

export async function userCount(appDb: AppDb): Promise<number> {
	const rows = await appDb<{ count: string | number }[]>`
		SELECT count(*) AS count FROM users WHERE password_hash IS NOT NULL
	`;
	return Number(rows[0]?.count ?? 0);
}

export async function findUserByEmail(
	appDb: AppDb,
	email: string,
): Promise<{ id: string; email: string; passwordHash: string } | null> {
	const rows = await appDb<
		Array<{ id: string; email: string; password_hash: string | null }>
	>`
		SELECT id, email, password_hash FROM users WHERE email = ${email}
	`;
	const row = rows[0];
	if (row === undefined || row.password_hash === null) {
		return null;
	}
	return { id: row.id, email: row.email, passwordHash: row.password_hash };
}

/**
 * Create a real account. The FIRST account additionally inherits the
 * pre-auth stub workspace (its connections, documents, history) as owner;
 * later accounts get their own default workspace.
 */
export async function createAccount(
	appDb: AppDb,
	email: string,
	passwordHash: string,
): Promise<{ userId: string; workspaceId: string }> {
	return appDb.begin(async (tx) => {
		const users = await tx<{ id: string }[]>`
			INSERT INTO users (email, password_hash)
			VALUES (${email}, ${passwordHash})
			RETURNING id
		`;
		const user = users[0];
		if (user === undefined) {
			throw new Error("User insert returned no row");
		}

		// Inherit the stub workspace only while it has no owner member —
		// i.e. exactly one real account (the first) inherits it.
		const stub = await tx<{ id: string }[]>`
			SELECT w.id FROM workspaces w
			JOIN users u ON u.id = w.owner_id
			WHERE u.email = 'local@datagripe.local'
				AND NOT EXISTS (
					SELECT 1 FROM workspace_members m
					WHERE m.workspace_id = w.id AND m.role = 'owner'
				)
			LIMIT 1
		`;
		let workspaceId: string;
		if (stub[0] !== undefined) {
			workspaceId = stub[0].id;
			await tx`
				INSERT INTO workspace_members (workspace_id, user_id, role)
				VALUES (${workspaceId}, ${user.id}, 'owner')
				ON CONFLICT (workspace_id, user_id) DO NOTHING
			`;
		} else {
			const workspaces = await tx<{ id: string }[]>`
				INSERT INTO workspaces (owner_id, name)
				VALUES (${user.id}, 'Local')
				RETURNING id
			`;
			const workspace = workspaces[0];
			if (workspace === undefined) {
				throw new Error("Workspace insert returned no row");
			}
			workspaceId = workspace.id;
			await tx`
				INSERT INTO workspace_members (workspace_id, user_id, role)
				VALUES (${workspaceId}, ${user.id}, 'owner')
			`;
		}
		return { userId: user.id, workspaceId };
	});
}

/** The user's default workspace (first membership) and their role. */
export async function defaultWorkspaceFor(
	appDb: AppDb,
	userId: string,
): Promise<{
	id: string;
	name: string;
	role: "owner" | "editor" | "viewer";
} | null> {
	const rows = await appDb<
		Array<{ id: string; name: string; role: "owner" | "editor" | "viewer" }>
	>`
		SELECT w.id, w.name, m.role
		FROM workspace_members m
		JOIN workspaces w ON w.id = m.workspace_id
		WHERE m.user_id = ${userId}
		ORDER BY w.created_at
		LIMIT 1
	`;
	return rows[0] ?? null;
}
