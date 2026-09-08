import {
	accessReportRequestSchema,
	accessRoleSetRequestSchema,
	accessRolesRequestSchema,
	connectionCreateRequestSchema,
	connectionDeleteRequestSchema,
	connectionTestRequestSchema,
	connectionUpdateRequestSchema,
	dismissalSchema,
	dismissRequestSchema,
	documentArchiveRequestSchema,
	documentCreateRequestSchema,
	documentFocusRequestSchema,
	documentGetRequestSchema,
	documentSaveRequestSchema,
	domainDeleteRequestSchema,
	domainExportPathRequestSchema,
	domainExportRequestSchema,
	domainGitRequestSchema,
	domainImportRequestSchema,
	domainListRequestSchema,
	domainRunsRequestSchema,
	domainTagRequestSchema,
	domainUpsertRequestSchema,
	executionCancelRequestSchema,
	executionStartRequestSchema,
	executionSubscribeRequestSchema,
	historyListRequestSchema,
	memberAddRequestSchema,
	memberRemoveRequestSchema,
	objectAlterRequestSchema,
	objectDescribeRequestSchema,
	redisGetRequestSchema,
	schemaChildrenRequestSchema,
	tableMutateRequestSchema,
	tableRowsRequestSchema,
	viewBroadcastRequestSchema,
	viewFollowRequestSchema,
	workspaceCreateRequestSchema,
	workspaceRenameRequestSchema,
	workspaceSetDefaultConnectionRequestSchema,
} from "@datagripe/contracts";
import { ErrorCodes } from "@datagripe/contracts/errors";
import type { ClientAction } from "@datagripe/contracts/ws";
import { buildReport, listRoles, setRoles } from "../access/service";
import type { AppConfig } from "../config";
import type { ConnectionsService } from "../connections/service";
import { ServiceError } from "../connections/service";
import { withIdempotency } from "../db/app/idempotency";
import type { AppDb } from "../db/app/pool";
import type { DocumentsService } from "../documents/service";
import { runExport } from "../domains/export";
import { runGit } from "../domains/git";
import { runImport } from "../domains/import";
import { parseExportRoots, resolveExportRoot } from "../domains/paths";
import {
	attachCommit,
	exportPath,
	listRuns,
	setExportPath,
} from "../domains/runs";
import {
	deleteDomain,
	listDomains,
	tag as tagObjects,
	upsertDomain,
} from "../domains/service";
import { listHistory } from "../execution/history";
import type { ExecutionRegistry } from "../execution/registry";
import {
	dismiss,
	listDismissals,
	restore,
	restoreAll,
} from "../gripes/dismissals";
import { log } from "../log";
import type { PresenceTracker } from "../multiplayer/presence";
import type { ViewBroadcastThrottle } from "../multiplayer/views";
import type { RateLimiter } from "../security/rateLimit";
import { addMember, listMembers, removeMember } from "../workspaces/members";
import {
	createWorkspace,
	listWorkspaces,
	renameWorkspace,
	setDefaultConnection,
} from "../workspaces/service";
import type { SocketHub } from "./hub";

/**
 * Action dispatcher (docs/spec/auth-and-hardening.md): every message is
 * validated and authorized against the socket-bound context — socket
 * authentication is not object authorization.
 */

export interface AuthContext {
	userId: string;
	sessionId: string;
	workspace: { id: string; name: string; defaultConnectionRef: string | null };
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
	documents: DocumentsService;
	executions: ExecutionRegistry;
	presence: PresenceTracker;
	viewThrottle: ViewBroadcastThrottle;
	hub: SocketHub;
	rateLimiter: RateLimiter;
	config: AppConfig;
}

const ROLE_RANK = { viewer: 0, editor: 1, owner: 2 } as const;
type Role = keyof typeof ROLE_RANK;

/** Minimum role per action (default viewer). */
const MINIMUM_ROLE: Partial<Record<ClientAction, Role>> = {
	"connection.create": "editor",
	"connection.update": "editor",
	"connection.delete": "editor",
	"connection.test": "editor",
	"document.create": "editor",
	"document.save": "editor",
	"document.archive": "editor",
	"execution.start": "editor",
	"execution.cancel": "editor",
	"workspace.set-default-connection": "editor",
	"table.mutate": "editor",
	"object.alter": "editor",
	"gripe.dismiss": "editor",
	"gripe.restore": "editor",
	"domain.upsert": "editor",
	"domain.delete": "editor",
	"domain.tag": "editor",
	// Editor, like the other datasource settings it sits beside on the
	// edit page. Using it still needs `owner`, because that is the step
	// that writes to disk.
	"domain.set-export-path": "editor",
	// Export writes to the host filesystem and git talks to a remote.
	// Reading who can do what is not a mutation, so `access.report` and
	// `domain.list` stay open to viewers: hiding the report from viewers
	// would mean the people most likely to notice a mistake cannot look.
	"access.roles.set": "editor",
	"domain.export": "owner",
	"domain.import": "owner",
	"domain.git": "owner",
	"workspace.rename": "owner",
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
	"table.rows": "table.rows",
	"table.mutate": "table.mutate",
	"object.describe": "object.describe",
	"object.alter": "object.alter",
	"access.report": "object.describe",
	"domain.export": "object.alter",
};

export function createDispatcher(deps: DispatcherDeps): Dispatch {
	const {
		appDb,
		connections,
		documents,
		executions,
		presence,
		viewThrottle,
		hub,
		rateLimiter,
		config,
	} = deps;
	const exportRoots = parseExportRoots(config.DOMAIN_EXPORT_ROOTS);

	/** Notify the workspace about a created/saved/archived document (6a). */
	function broadcastDocumentChanged(
		workspaceId: string,
		entry: {
			id: string;
			title: string;
			revision: number;
			updatedAt: string;
		},
		archived: boolean,
	): void {
		hub.broadcastToWorkspace(workspaceId, {
			version: 1,
			kind: "event",
			eventId: crypto.randomUUID(),
			topic: "document.changed",
			occurredAt: new Date().toISOString(),
			payload: {
				id: entry.id,
				title: entry.title,
				revision: entry.revision,
				updatedAt: entry.updatedAt,
				archived,
			},
		});
	}

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
					workspace: {
						id: workspace.id,
						name: workspace.name,
						defaultConnectionRef: workspace.defaultConnectionRef,
						role: ctx.role,
					},
					connections: await connections.listConnections(workspace),
					adapters: connections.adapterInfos(),
					documents: await documents.listDocuments(workspace.id),
				};

			case "document.get": {
				const request = documentGetRequestSchema.parse(payload);
				return {
					document: await documents.getDocument(workspace.id, request.id),
				};
			}

			case "document.create": {
				const request = documentCreateRequestSchema.parse(payload);
				const result = await withIdempotency(
					appDb,
					workspace.id,
					action,
					request.idempotencyKey,
					async () => ({
						document: await documents.createDocument(workspace.id, request),
					}),
				);
				broadcastDocumentChanged(workspace.id, result.document, false);
				return result;
			}

			case "document.save": {
				const request = documentSaveRequestSchema.parse(payload);
				const result = await withIdempotency(
					appDb,
					workspace.id,
					action,
					request.idempotencyKey,
					async () => ({
						document: await documents.saveDocument(workspace.id, request),
					}),
				);
				broadcastDocumentChanged(workspace.id, result.document, false);
				return result;
			}

			case "document.archive": {
				const request = documentArchiveRequestSchema.parse(payload);
				const archived = await documents.archiveDocument(
					workspace.id,
					request.id,
				);
				broadcastDocumentChanged(workspace.id, archived, true);
				return {};
			}

			case "document.focus": {
				const request = documentFocusRequestSchema.parse(payload);
				const users = presence.focus(
					workspace.id,
					ctx.userId,
					request.documentId,
				);
				if (users !== null) {
					hub.broadcastToWorkspace(workspace.id, {
						version: 1,
						kind: "event",
						eventId: crypto.randomUUID(),
						topic: "presence.update",
						occurredAt: new Date().toISOString(),
						payload: { users },
					});
				}
				return {};
			}

			case "view.broadcast": {
				const request = viewBroadcastRequestSchema.parse(payload);
				if (!viewThrottle.allow(ctx.userId)) {
					return { dropped: true };
				}
				hub.broadcastToWorkspace(workspace.id, {
					version: 1,
					kind: "event",
					eventId: crypto.randomUUID(),
					topic: "view.state",
					occurredAt: new Date().toISOString(),
					payload: { userId: ctx.userId, ...request },
				});
				return {};
			}

			case "view.follow":
			case "view.unfollow": {
				const request = viewFollowRequestSchema.parse(payload);
				hub.broadcastToUser(request.userId, {
					version: 1,
					kind: "event",
					eventId: crypto.randomUUID(),
					topic: "view.followed",
					occurredAt: new Date().toISOString(),
					payload: {
						followerUserId: ctx.userId,
						following: action === "view.follow",
					},
				});
				return {};
			}

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

			case "workspace.create": {
				const request = workspaceCreateRequestSchema.parse(payload);
				return {
					workspace: await createWorkspace(appDb, ctx.userId, request.name),
				};
			}

			case "workspace.list":
				return { workspaces: await listWorkspaces(appDb, ctx.userId) };

			case "workspace.set-default-connection": {
				const request =
					workspaceSetDefaultConnectionRequestSchema.parse(payload);
				await setDefaultConnection(
					appDb,
					workspace.id,
					request.connectionRef,
					(ref) => connections.hasConnectionRef(workspace, ref),
				);
				return {};
			}

			case "workspace.rename": {
				const request = workspaceRenameRequestSchema.parse(payload);
				await renameWorkspace(appDb, workspace.id, request.name);
				return { workspace: { id: workspace.id, name: request.name } };
			}

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

			case "table.rows": {
				const request = tableRowsRequestSchema.parse(payload);
				// Browsing rows is a viewer's job, but the `where …` box takes a
				// raw predicate — arbitrary read SQL, which is exactly what
				// execution.start withholds from viewers. Keep the boundary in
				// one place rather than two.
				if (ctx.role === "viewer" && request.filter.trim() !== "") {
					throw new ServiceError(
						ErrorCodes.Forbidden,
						"Role 'viewer' cannot filter rows with a predicate",
					);
				}
				return connections.readTable(workspace, request);
			}

			case "table.mutate": {
				const request = tableMutateRequestSchema.parse(payload);
				// Idempotent so a retried commit after a dropped socket cannot
				// apply the same row edits twice.
				return withIdempotency(
					appDb,
					workspace.id,
					action,
					request.idempotencyKey,
					() => connections.mutateTable(workspace, request),
				);
			}

			case "object.describe": {
				const request = objectDescribeRequestSchema.parse(payload);
				return connections.describeObject(workspace, request);
			}

			case "object.alter": {
				const request = objectAlterRequestSchema.parse(payload);
				// A preview runs nothing, so it needs no idempotency key
				// honoured; an apply must not run twice on a retried socket.
				if (request.dryRun) {
					return connections.alterColumns(workspace, request);
				}
				return withIdempotency(
					appDb,
					workspace.id,
					action,
					request.idempotencyKey,
					() => connections.alterColumns(workspace, request),
				);
			}

			case "gripe.dismissals":
				return { dismissals: await listDismissals(appDb, workspace.id) };

			case "gripe.dismiss": {
				const request = dismissRequestSchema.parse(payload);
				return {
					dismissals: await dismiss(appDb, workspace.id, ctx.userId, request),
				};
			}

			case "gripe.restore": {
				// An empty payload restores everything, which is the panel's
				// "show hidden" escape; a dismissal restores just that one.
				if (payload === null || payload === undefined) {
					return {
						dismissals: await restoreAll(appDb, workspace.id, ctx.userId),
					};
				}
				const request = dismissalSchema.parse(payload);
				return {
					dismissals: await restore(appDb, workspace.id, ctx.userId, request),
				};
			}

			case "domain.list": {
				const request = domainListRequestSchema.parse(payload);
				return listDomains(appDb, workspace.id, request.connectionRef);
			}

			case "domain.upsert": {
				const request = domainUpsertRequestSchema.parse(payload);
				return withIdempotency(
					appDb,
					workspace.id,
					action,
					request.idempotencyKey,
					() => upsertDomain(appDb, workspace.id, request),
				);
			}

			case "domain.delete": {
				const request = domainDeleteRequestSchema.parse(payload);
				return deleteDomain(appDb, workspace.id, request);
			}

			case "domain.tag": {
				const request = domainTagRequestSchema.parse(payload);
				return withIdempotency(
					appDb,
					workspace.id,
					action,
					request.idempotencyKey,
					() => tagObjects(appDb, workspace.id, ctx.userId, request),
				);
			}

			case "domain.runs": {
				const request = domainRunsRequestSchema.parse(payload);
				const configured = await exportPath(
					appDb,
					workspace.id,
					request.connectionRef,
				);
				// The root is reported only when it currently resolves inside
				// the allowlist, so the tab never shows a target it cannot
				// actually write to.
				let root: string | null = null;
				if (exportRoots.length > 0) {
					root = await resolveExportRoot(configured, exportRoots).catch(
						() => null,
					);
				}
				return {
					runs: await listRuns(
						appDb,
						workspace.id,
						request.connectionRef,
						request.limit,
					),
					root,
					exportEnabled: exportRoots.length > 0,
					gitEnabled: config.DOMAIN_EXPORT_GIT,
				};
			}

			case "domain.export": {
				const request = domainExportRequestSchema.parse(payload);
				const run = () =>
					runExport(
						{
							appDb,
							connections,
							exportRoots,
							maxDataRows: config.DOMAIN_EXPORT_MAX_DATA_ROWS,
							maxCells: config.ACCESS_REPORT_MAX_CELLS,
							onProgress: (done, total, current) => {
								hub.broadcastToWorkspace(workspace.id, {
									version: 1,
									kind: "event",
									eventId: crypto.randomUUID(),
									topic: "domain.export.progress",
									occurredAt: new Date().toISOString(),
									payload: {
										connectionRef: request.connectionRef,
										done,
										total,
										current,
									},
								});
							},
						},
						workspace,
						ctx.userId,
						request,
					);
				// A dry run writes nothing, so it needs no idempotency key
				// honoured; an apply must not run twice on a retried socket.
				if (request.dryRun) {
					return run();
				}
				return withIdempotency(
					appDb,
					workspace.id,
					action,
					request.idempotencyKey,
					run,
				);
			}

			case "domain.import": {
				const request = domainImportRequestSchema.parse(payload);
				const run = () =>
					runImport(
						{ appDb, connections, exportRoots },
						workspace,
						ctx.userId,
						request,
					);
				// A preview reads a file and writes nothing.
				if (request.dryRun) {
					return run();
				}
				return withIdempotency(
					appDb,
					workspace.id,
					action,
					request.idempotencyKey,
					run,
				);
			}

			case "domain.set-export-path": {
				const request = domainExportPathRequestSchema.parse(payload);
				// Validation, not a save: the field's `check path` action.
				if (request.checkOnly) {
					if (request.path.trim() === "") {
						return {
							ok: true,
							resolved: null,
							message: "No directory — export stays off for this datasource",
						};
					}
					try {
						const resolved = await resolveExportRoot(request.path, exportRoots);
						return { ok: true, resolved, message: "allowed" };
					} catch (error) {
						return {
							ok: false,
							resolved: null,
							message:
								error instanceof Error ? error.message : "Path is not allowed",
						};
					}
				}
				await setExportPath(
					appDb,
					workspace.id,
					request.connectionRef,
					request.path,
				);
				// The connection list carries the path, so the caller gets the
				// updated datasource back rather than having to refetch.
				return { connections: await connections.listConnections(workspace) };
			}

			case "domain.git": {
				if (!config.DOMAIN_EXPORT_GIT) {
					throw new ServiceError(
						ErrorCodes.Forbidden,
						"Committing is disabled — DOMAIN_EXPORT_GIT is off",
					);
				}
				const request = domainGitRequestSchema.parse(payload);
				const configured = await exportPath(
					appDb,
					workspace.id,
					request.connectionRef,
				);
				const root = await resolveExportRoot(configured, exportRoots);
				const result = await runGit(
					root,
					request.operation,
					request.message,
					{ timeoutMs: config.DOMAIN_GIT_TIMEOUT_MS },
					{ workspaceId: workspace.id, userId: ctx.userId },
				);
				if (request.runId !== undefined && result.commitSha !== null) {
					await attachCommit(
						appDb,
						workspace.id,
						request.runId,
						result.commitSha,
					);
				}
				return result;
			}

			case "access.roles": {
				const request = accessRolesRequestSchema.parse(payload);
				return listRoles(appDb, connections, workspace, request.connectionId);
			}

			case "access.roles.set": {
				const request = accessRoleSetRequestSchema.parse(payload);
				await setRoles(appDb, workspace.id, request);
				return listRoles(appDb, connections, workspace, request.connectionId);
			}

			case "access.report": {
				const request = accessReportRequestSchema.parse(payload);
				const bundle = await buildReport(
					appDb,
					connections,
					workspace,
					request,
					config.ACCESS_REPORT_MAX_CELLS,
				);
				return {
					...bundle.result,
					findings: bundle.findings,
					untrusted: bundle.untrusted,
				};
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
				return executions.cancel(ctx.userId, ctx.role, request.executionId);
			}

			case "execution.subscribe": {
				const request = executionSubscribeRequestSchema.parse(payload);
				return {
					events: executions.replay(
						workspace.id,
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
					workspace.id,
					request.limit,
					request.offset,
					request.scope,
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
