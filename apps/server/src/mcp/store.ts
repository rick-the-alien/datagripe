import { createHash, randomBytes } from "node:crypto";
import type { McpMode, McpToken } from "@datagripe/contracts";
import { MCP_TOKEN_PREFIX } from "@datagripe/contracts";
import type { AppDb } from "../db/app/pool";

/**
 * The two MCP rows (docs/spec/mcp.md): a project's settings and its
 * tokens. Plain queries only — what may be asked of them lives in
 * `service.ts`.
 */

export interface McpSettings {
	enabled: boolean;
	mode: McpMode;
	updatedAt: string | null;
}

/** Absent means off: a project nobody configured has nothing listening. */
const OFF: McpSettings = { enabled: false, mode: "read-only", updatedAt: null };

export function hashToken(value: string): string {
	return createHash("sha256").update(value).digest("hex");
}

export async function readSettings(
	appDb: AppDb,
	workspaceId: string,
): Promise<McpSettings> {
	const rows = await appDb<
		Array<{ enabled: boolean; mode: McpMode; updated_at: string | Date }>
	>`
		SELECT enabled, mode, updated_at FROM mcp_settings
		WHERE workspace_id = ${workspaceId}
	`;
	const row = rows[0];
	return row === undefined
		? OFF
		: {
				enabled: row.enabled,
				mode: row.mode,
				updatedAt: new Date(row.updated_at).toISOString(),
			};
}

export async function writeSettings(
	appDb: AppDb,
	workspaceId: string,
	userId: string,
	settings: { enabled: boolean; mode: McpMode },
): Promise<McpSettings> {
	const rows = await appDb<
		Array<{ enabled: boolean; mode: McpMode; updated_at: string | Date }>
	>`
		INSERT INTO mcp_settings (workspace_id, enabled, mode, updated_by, updated_at)
		VALUES (${workspaceId}, ${settings.enabled}, ${settings.mode}, ${userId}, now())
		ON CONFLICT (workspace_id) DO UPDATE SET
			enabled = ${settings.enabled},
			mode = ${settings.mode},
			updated_by = ${userId},
			updated_at = now()
		RETURNING enabled, mode, updated_at
	`;
	const row = rows[0];
	if (row === undefined) {
		throw new Error("mcp_settings upsert returned no row");
	}
	return {
		enabled: row.enabled,
		mode: row.mode,
		updatedAt: new Date(row.updated_at).toISOString(),
	};
}

type TokenRow = {
	id: string;
	name: string;
	email: string | null;
	created_at: string | Date;
	last_used_at: string | Date | null;
};

function rowToToken(row: TokenRow): McpToken {
	return {
		id: row.id,
		name: row.name,
		createdBy: row.email ?? "unknown",
		createdAt: new Date(row.created_at).toISOString(),
		lastUsedAt:
			row.last_used_at === null
				? null
				: new Date(row.last_used_at).toISOString(),
	};
}

/** Live tokens, newest first. Revoked ones are gone, not greyed out. */
export async function listTokens(
	appDb: AppDb,
	workspaceId: string,
): Promise<McpToken[]> {
	const rows = await appDb<TokenRow[]>`
		SELECT t.id, t.name, u.email, t.created_at, t.last_used_at
		FROM mcp_tokens t
		LEFT JOIN users u ON u.id = t.user_id
		WHERE t.workspace_id = ${workspaceId} AND t.revoked_at IS NULL
		ORDER BY t.created_at DESC
	`;
	return rows.map(rowToToken);
}

export async function createToken(
	appDb: AppDb,
	workspaceId: string,
	userId: string,
	name: string,
): Promise<{ token: McpToken; value: string }> {
	const value = `${MCP_TOKEN_PREFIX}${randomBytes(32).toString("base64url")}`;
	const rows = await appDb<TokenRow[]>`
		WITH inserted AS (
			INSERT INTO mcp_tokens (workspace_id, user_id, name, token_hash)
			VALUES (${workspaceId}, ${userId}, ${name}, ${hashToken(value)})
			RETURNING id, user_id, name, created_at, last_used_at
		)
		SELECT i.id, i.name, u.email, i.created_at, i.last_used_at
		FROM inserted i LEFT JOIN users u ON u.id = i.user_id
	`;
	const row = rows[0];
	if (row === undefined) {
		throw new Error("mcp_tokens insert returned no row");
	}
	return { token: rowToToken(row), value };
}

/** Revocation is the only control on a token's lifetime; it is final. */
export async function revokeToken(
	appDb: AppDb,
	workspaceId: string,
	id: string,
): Promise<boolean> {
	const rows = await appDb<Array<{ id: string }>>`
		UPDATE mcp_tokens SET revoked_at = now()
		WHERE workspace_id = ${workspaceId} AND id = ${id} AND revoked_at IS NULL
		RETURNING id
	`;
	return rows.length > 0;
}

export interface TokenIdentity {
	id: string;
	workspaceId: string;
	userId: string;
	name: string;
}

/**
 * The token behind a bearer value. A hash lookup rather than a compare:
 * there is nothing to leak by timing when the index does the finding.
 */
export async function lookupToken(
	appDb: AppDb,
	value: string,
): Promise<TokenIdentity | null> {
	const rows = await appDb<
		Array<{ id: string; workspace_id: string; user_id: string; name: string }>
	>`
		SELECT id, workspace_id, user_id, name FROM mcp_tokens
		WHERE token_hash = ${hashToken(value)} AND revoked_at IS NULL
	`;
	const row = rows[0];
	return row === undefined
		? null
		: {
				id: row.id,
				workspaceId: row.workspace_id,
				userId: row.user_id,
				name: row.name,
			};
}

/** Fire-and-forget: `last_used_at` is for a human, not for a decision. */
export function touchToken(appDb: AppDb, id: string): void {
	void appDb`
		UPDATE mcp_tokens SET last_used_at = now() WHERE id = ${id}
	`.catch(() => {});
}
