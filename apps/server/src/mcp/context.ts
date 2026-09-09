import type { McpMode } from "@datagripe/contracts";
import { ErrorCodes } from "@datagripe/contracts/errors";
import type { AppConfig } from "../config";
import type { ConnectionsService } from "../connections/service";
import { ServiceError } from "../connections/service";
import type { AppDb } from "../db/app/pool";
import type { DocumentsService } from "../documents/service";
import type { HostFsPolicy } from "../domains/paths";
import type { ExecutionRegistry } from "../execution/registry";
import type { GitDatasourcesService } from "../git/types";
import type { RateLimiter } from "../security/rateLimit";
import { lookupToken, readSettings, touchToken } from "./store";

/**
 * Who is calling, and what the project lets them do
 * (docs/spec/mcp.md "Authentication").
 */

export interface McpDeps {
	appDb: AppDb;
	config: AppConfig;
	connections: ConnectionsService;
	documents: DocumentsService;
	executions: ExecutionRegistry;
	rateLimiter: RateLimiter;
	hostFs: HostFsPolicy;
	/** Present when git datasources are available; the briefing uses it. */
	gitDatasources?: GitDatasourcesService;
}

export interface McpContext {
	workspace: { id: string; name: string; defaultConnectionRef: string | null };
	userId: string;
	token: { id: string; name: string };
	/**
	 * The minting user's current role, capped at `editor`. Never `owner`:
	 * nothing reachable over MCP may mint a token, change the mode, add a
	 * member or approve a repository command, and a context that cannot
	 * hold `owner` cannot grow a tool that does by accident.
	 */
	role: "viewer" | "editor";
	mode: McpMode;
}

type MembershipRow = {
	id: string;
	name: string;
	default_connection_ref: string | null;
	role: "owner" | "editor" | "viewer" | null;
	owner_id: string;
};

/**
 * Resolve a bearer token to a context, or throw the refusal an agent
 * should see.
 *
 * The role is resolved here, on every call, and never stored on the
 * token: a token delegates one person's access, so demoting or removing
 * them has to take their agent's access with it. That property is what
 * makes a token with no expiry acceptable.
 */
export async function authenticate(
	deps: McpDeps,
	projectId: string,
	authorization: string | null,
): Promise<McpContext> {
	const bearer = /^Bearer\s+(.+)$/i.exec(authorization ?? "")?.[1]?.trim();
	if (bearer === undefined || bearer === "") {
		throw new ServiceError(
			ErrorCodes.Unauthorized,
			"This endpoint needs an Authorization: Bearer header with a DataGripe MCP token",
		);
	}
	const token = await lookupToken(deps.appDb, bearer);
	if (token === null) {
		throw new ServiceError(
			ErrorCodes.Unauthorized,
			"That MCP token is not valid — it may have been revoked",
		);
	}
	// A project id the caller cannot prove is a project we do not discuss:
	// not-found, rather than a forbidden that confirms it exists.
	if (token.workspaceId !== projectId) {
		throw new ServiceError(ErrorCodes.NotFound, "No such project");
	}
	const settings = await readSettings(deps.appDb, token.workspaceId);
	if (!settings.enabled) {
		throw new ServiceError(
			ErrorCodes.Forbidden,
			"MCP is switched off for this project — an owner can turn it on in DataGripe's mcp panel",
		);
	}
	const rows = await deps.appDb<MembershipRow[]>`
		SELECT w.id, w.name, w.default_connection_ref, w.owner_id, m.role
		FROM workspaces w
		LEFT JOIN workspace_members m
			ON m.workspace_id = w.id AND m.user_id = ${token.userId}
		WHERE w.id = ${token.workspaceId}
	`;
	const row = rows[0];
	if (row === undefined) {
		throw new ServiceError(ErrorCodes.NotFound, "No such project");
	}
	// Direct-in mode (AUTH_DISABLED) has no membership rows at all — the
	// stub workspace has an owner and no members. Anywhere else, a
	// missing row means the person was removed from the project, and
	// their token goes with them.
	const membership =
		row.role ??
		(deps.config.AUTH_DISABLED && row.owner_id === token.userId
			? "owner"
			: null);
	if (membership === null) {
		throw new ServiceError(
			ErrorCodes.Forbidden,
			"The account this token belongs to is no longer a member of this project",
		);
	}
	touchToken(deps.appDb, token.id);
	return {
		workspace: {
			id: row.id,
			name: row.name,
			defaultConnectionRef: row.default_connection_ref,
		},
		userId: token.userId,
		token: { id: token.id, name: token.name },
		role: membership === "viewer" ? "viewer" : "editor",
		mode: settings.mode,
	};
}

/**
 * The gate on a query that will commit.
 *
 * Read-only mode needs no role beyond membership: the statement is
 * classified and sandboxed, so it can do no more than the table view a
 * viewer already has. Committing is the app's `execution.start`, which
 * is an editor action, and this is the same rule under a different
 * front door.
 */
export function requireCommitRole(ctx: McpContext): void {
	if (ctx.role !== "editor") {
		throw new ServiceError(
			ErrorCodes.Forbidden,
			`This token belongs to a viewer, who may read but not run a query that commits. The project's mcp mode is read/write; switch it back, or give the account editor access.`,
		);
	}
}
