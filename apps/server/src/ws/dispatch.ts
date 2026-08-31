import {
	connectionCreateRequestSchema,
	connectionDeleteRequestSchema,
	connectionTestRequestSchema,
	connectionUpdateRequestSchema,
	executionCancelRequestSchema,
	executionStartRequestSchema,
	executionSubscribeRequestSchema,
	historyListRequestSchema,
	memberAddRequestSchema,
	memberRemoveRequestSchema,
	redisGetRequestSchema,
	schemaChildrenRequestSchema,
} from "@datagripe/contracts";
import { ErrorCodes } from "@datagripe/contracts/errors";
import type { ClientAction } from "@datagripe/contracts/ws";
import type { ConnectionsService } from "../connections/service";
import { ServiceError } from "../connections/service";
import { withIdempotency } from "../db/app/idempotency";
import type { AppDb } from "../db/app/pool";
import { listHistory } from "../execution/history";
import type { ExecutionRegistry } from "../execution/registry";
import { log } from "../log";
import type { RateLimiter } from "../security/rateLimit";
import { addMember, listMembers, removeMember } from "../workspaces/members";

/**
 * Action dispatcher (docs/spec/auth-and-hardening.md): every message is
 * validated and authorized against the socket-bound context — socket
 * authentication is not object authorization.
 */

export interface AuthContext {
	userId: string;
	sessionId: string;
	workspace: { id: string; name: string };
	role: "owner" | "editor" | "viewer";
}

export type Dispatch = (
	ctx: AuthContext,
	action: ClientAction,
	payload: unknown,
) => Promise<unknown>;

export interface DispatcherDeps {
	appDb: AppDb;
	connections: ConnectionsService;
	executions: ExecutionRegistry;
	rateLimiter: RateLimiter;
}

const ROLE_RANK = { viewer: 0, editor: 1, owner: 2 } as const;
type Role = keyof typeof ROLE_RANK;

/** Minimum role per action (default viewer). */
const MINIMUM_ROLE: Partial<Record<ClientAction, Role>> = {
	"connection.create": "editor",
	"connection.update": "editor",
	"connection.delete": "editor",
	"connection.test": "editor",
	"execution.start": "editor",
	"execution.cancel": "editor",
	"workspace.member.add": "owner",
	"workspace.member.remove": "owner",
};

function requireRole(ctx: AuthContext, action: ClientAction): void {
	const minimum = MINIMUM_ROLE[action] ?? "viewer";
	if (ROLE_RANK[ctx.role] < ROLE_RANK[minimum]) {
		throw new ServiceError(
			ErrorCodes.Forbidden,
			`Role '${ctx.role}' cannot perform '${action}'`,
		);
	}
}

/** Rate-limited actions and their limiter scopes. */
const RATE_SCOPES: Partial<Record<ClientAction, string>> = {
	"connection.test": "connection.test",
	"execution.start": "execution.start",
	"schema.children": "schema.children",
};

export function createDispatcher(deps: DispatcherDeps): Dispatch {
	const { appDb, connections, executions, rateLimiter } = deps;

	return async (ctx, action, payload) => {
		requireRole(ctx, action);
		const scope = RATE_SCOPES[action];
		if (scope !== undefined && !rateLimiter.take(scope, ctx.userId)) {
			throw new ServiceError(
				ErrorCodes.RateLimited,
				"Too many requests — slow down",
			);
		}
		const startedAt = performance.now();
		try {
			const result = await route(ctx, action, payload);
			log.debug("action ok", {
				action,
				userId: ctx.userId,
				durationMs: Math.round(performance.now() - startedAt),
			});
			return result;
		} catch (error) {
			log.debug("action error", {
				action,
				userId: ctx.userId,
				durationMs: Math.round(performance.now() - startedAt),
				error: error instanceof Error ? error.message : String(error),
			});
			throw error;
		}
	};

	async function route(
		ctx: AuthContext,
		action: ClientAction,
		payload: unknown,
	): Promise<unknown> {
		const { workspace } = ctx;
		switch (action) {
			case "workspace.open":
				return {
					workspace,
					connections: await connections.listConnections(workspace),
					adapters: connections.adapterInfos(),
				};

			case "redis.get": {
				const request = redisGetRequestSchema.parse(payload);
				return connections.getKeyValue(
					workspace,
					request.connectionId,
					request.key,
				);
			}

			case "workspace.members":
				return { members: await listMembers(appDb, workspace.id) };

			case "workspace.member.add": {
				const request = memberAddRequestSchema.parse(payload);
				return addMember(appDb, workspace.id, request.email, request.role);
			}

			case "workspace.member.remove": {
				const request = memberRemoveRequestSchema.parse(payload);
				await removeMember(appDb, workspace.id, request.userId);
				return {};
			}

			case "connection.create": {
				const request = connectionCreateRequestSchema.parse(payload);
				return withIdempotency(
					appDb,
					workspace.id,
					action,
					request.idempotencyKey,
					() => connections.createConnection(workspace, request),
				);
			}

			case "connection.update": {
				const request = connectionUpdateRequestSchema.parse(payload);
				return withIdempotency(
					appDb,
					workspace.id,
					action,
					request.idempotencyKey,
					() => connections.updateConnection(workspace, request),
				);
			}

			case "connection.delete": {
				const request = connectionDeleteRequestSchema.parse(payload);
				return withIdempotency(
					appDb,
					workspace.id,
					action,
					request.idempotencyKey,
					() => connections.deleteConnection(workspace, request.id),
				);
			}

			case "connection.test": {
				const request = connectionTestRequestSchema.parse(payload);
				return connections.testConnection(workspace, request);
			}

			case "schema.children": {
				const request = schemaChildrenRequestSchema.parse(payload);
				return {
					nodes: await connections.schemaChildren(
						workspace,
						request.connectionId,
						request.path,
						request.refresh,
					),
				};
			}

			case "execution.start": {
				const request = executionStartRequestSchema.parse(payload);
				return withIdempotency(
					appDb,
					workspace.id,
					action,
					request.idempotencyKey,
					() => executions.start(ctx.userId, workspace, request),
				);
			}

			case "execution.cancel": {
				const request = executionCancelRequestSchema.parse(payload);
				return executions.cancel(ctx.userId, request.executionId);
			}

			case "execution.subscribe": {
				const request = executionSubscribeRequestSchema.parse(payload);
				return {
					events: executions.replay(
						ctx.userId,
						request.executionId,
						request.afterSequence,
					),
				};
			}

			case "history.list": {
				const request = historyListRequestSchema.parse(payload);
				return listHistory(
					appDb,
					ctx.userId,
					request.limit,
					request.offset,
					(id) => connections.predefinedName(id),
				);
			}

			default:
				throw new ServiceError(
					ErrorCodes.NotFound,
					`Action '${action}' is not implemented yet`,
				);
		}
	}
}
