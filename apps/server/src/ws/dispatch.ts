import type {
	Document,
	DocumentOrigin,
	RepoCommandsState,
} from "@datagripe/contracts";
import {
	accessReportRequestSchema,
	accessRoleSetRequestSchema,
	accessRolesRequestSchema,
	connectionCreateRequestSchema,
	connectionDeleteRequestSchema,
	connectionTestRequestSchema,
	connectionUpdateRequestSchema,
	datasourcePathsSetRequestSchema,
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
	exportConfigRequestSchema,
	fileListRequestSchema,
	fileOpenRequestSchema,
	gitCommitRequestSchema,
	gitDatasourceAddRequestSchema,
	gitDatasourceOptionsRequestSchema,
	gitDatasourceReloadRequestSchema,
	gitDatasourceRemoveRequestSchema,
	gitPullRequestSchema,
	gitPushRequestSchema,
	gitStageRequestSchema,
	gitStatusRequestSchema,
	historyListRequestSchema,
	hostPathCheckRequestSchema,
	memberAddRequestSchema,
	memberRemoveRequestSchema,
	objectAlterRequestSchema,
	objectDescribeRequestSchema,
	redisGetRequestSchema,
	repoCommandsRequestSchema,
	repoRunCancelRequestSchema,
	repoRunRequestSchema,
	repoTrustRequestSchema,
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
import { resolveExportTarget, runExport } from "../domains/export";
import { runImport } from "../domains/import";
import {
	type HostFsPolicy,
	parseHostRoots,
	resolveHostDirectory,
} from "../domains/paths";
import { attachCommit, listRuns, setExportPath } from "../domains/runs";
import {
	deleteDomain,
	listDomains,
	tag as tagObjects,
	upsertDomain,
} from "../domains/service";
import { listHistory } from "../execution/history";
import type { ExecutionRegistry } from "../execution/registry";
import {
	hashContent,
	listDirectory,
	readTextFile,
	writeTextFile,
} from "../files/browse";
import { getDatasourcePath, setDatasourcePaths } from "../files/service";
import {
	clearTrust,
	hashCommands,
	readCommands,
	readTrust,
	setTrust,
} from "../git/commands";
import { isDatagripeFile, relativeToRepo, writeSync } from "../git/config";
import { dirtyOriginPaths } from "../git/dirty";
import { runGit } from "../git/export";
import { runExportConfig } from "../git/exportConfig";
import * as gitRepo from "../git/repo";
import type { GitOptions } from "../git/run";
import type { CommandRunner } from "../git/runner";
import { idFromRef } from "../git/store";
import type {
	GitDatasourceEntry,
	GitDatasourcesServiceWithAdmin,
} from "../git/types";
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
	/** Present when GIT_ENABLED and the host filesystem is available. */
	gitDatasources?: GitDatasourcesServiceWithAdmin;
	/** Present only when REPO_COMMANDS_ENABLED is on as well. */
	commandRunner?: CommandRunner;
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
	// Same reasoning: configuring a datasource's paths is a datasource
	// setting, sitting on the edit page with the rest of them. Reading
	// what is inside one is a viewer action — the sidebar is how you find
	// the query you were asked to run.
	"datasource.set-paths": "editor",
	"datasource.check-path": "editor",
	// `file.open` caches the file as a workspace document, and a save
	// writes it back to disk, so it is an editor action rather than a
	// viewer one.
	"file.open": "editor",
	// Export writes to the host filesystem and git talks to a remote.
	// Reading who can do what is not a mutation, so `access.report` and
	// `domain.list` stay open to viewers: hiding the report from viewers
	// would mean the people most likely to notice a mistake cannot look.
	"access.roles.set": "editor",
	"domain.export": "owner",
	"domain.import": "owner",
	"domain.git": "owner",
	// The repository section (docs/spec/git-datasources.md "Actions").
	//
	// `commit` and `pull` are a deliberate departure from
	// docs/spec/domains.md, where every git verb is `owner`. That rule
	// exists because `domain.git` writes a generated tree and pushes it;
	// an editor who may already open a file, edit it and write it back to
	// disk is not meaningfully more dangerous for being able to record
	// that in the local history.
	"git.status": "editor",
	"git.stage": "editor",
	"git.commit": "editor",
	"git.pull": "editor",
	"git.datasource.reload": "editor",
	// The password and the two overrides are this project's settings
	// about a datasource, like the export path it sits beside on the same
	// page — not a change to the datasource itself.
	"git.datasource.set-options": "editor",
	"datasource.export-config": "editor",
	// Approving a command list is the moment somebody vouches for code
	// from a repository, and running one executes it on the host. Both
	// are `owner`: this is the only feature in DataGripe that runs a
	// program it did not write (docs/spec/repo-commands.md).
	"repo.trust": "owner",
	"repo.run": "owner",
	"repo.run.cancel": "owner",
	// These two reach the network, which is where the line is.
	"git.push": "owner",
	"git.datasource.add": "owner",
	"git.datasource.remove": "owner",
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
	// Expanding a tree is a disk read per click, so it shares the
	// schema-tree budget rather than getting an unmetered one.
	"file.list": "schema.children",
	"file.open": "schema.children",
	// A status is a `git` process, so it shares the same budget rather
	// than being free to hammer from a refresh button.
	"git.status": "schema.children",
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
	// HOST_FS_ROOTS is an optional allowlist; DOMAIN_EXPORT_ROOTS is its
	// pre-rename name, still honoured so an existing .env keeps working.
	const hostFs: HostFsPolicy = {
		roots: parseHostRoots(
			config.HOST_FS_ROOTS === ""
				? config.DOMAIN_EXPORT_ROOTS
				: config.HOST_FS_ROOTS,
		),
		disabled: config.HOST_FS_DISABLED,
	};

	/**
	 * Write a file-backed document's content to the file it came from.
	 *
	 * The datasource path is re-read and re-resolved on every write rather
	 * than remembered when the file was opened: the pair can be repointed,
	 * removed, or have a symlink swapped underneath it while a tab sits
	 * open, and none of those may turn into a write somewhere else.
	 */
	async function writeDocumentToDisk(
		workspaceId: string,
		document: Document,
	): Promise<void> {
		const origin = document.origin;
		if (origin === null) {
			return;
		}
		const configured = await getDatasourcePath(
			appDb,
			workspaceId,
			origin.pathId,
		);
		const root = await resolveHostDirectory(
			configured.path,
			hostFs,
			"datasource path",
		);
		const written = await writeTextFile(
			root,
			origin.filePath,
			document.content,
		);
		await documents.markDiskSynced(document.id, written.hash);
	}

	/**
	 * Resolve one datasource path to a real directory, proving on the way
	 * that it belongs to the datasource the caller named. Without that
	 * check a path id is a workspace-wide handle, and the connection ref
	 * in the request would be decoration.
	 */
	async function resolveDatasourcePath(
		workspaceId: string,
		connectionRef: string,
		pathId: string,
	): Promise<string> {
		const configured = await getDatasourcePath(appDb, workspaceId, pathId);
		if (configured.connectionRef !== connectionRef) {
			throw new ServiceError(
				ErrorCodes.Forbidden,
				"That path belongs to a different datasource",
			);
		}
		return resolveHostDirectory(configured.path, hostFs, "datasource path");
	}

	/** Notify the workspace about a created/saved/archived document (6a). */
	/**
	 * Git datasources, or a named refusal. `GIT_ENABLED` gates the whole
	 * feature, and the buttons are absent rather than
	 * disabled-with-a-tooltip when it is off — so reaching here at all
	 * means something went around the UI.
	 */
	/**
	 * The command runner, or a named refusal. Its own gate, separate from
	 * `GIT_ENABLED`: wanting git datasources is not the same decision as
	 * wanting DataGripe to execute a program from a repository.
	 */
	function requireCommandsEnabled(): CommandRunner {
		if (deps.commandRunner === undefined) {
			throw new ServiceError(
				ErrorCodes.Forbidden,
				"Running a repository's commands is disabled — REPO_COMMANDS_ENABLED is off",
			);
		}
		return deps.commandRunner;
	}

	/** What the panel needs: the list, its hash, and who vouched for it. */
	async function commandsState(
		workspaceId: string,
		connectionRef: string,
		repoPath: string,
	): Promise<RepoCommandsState> {
		const id = idFromRef(connectionRef);
		const { commands } = await readCommands(repoPath);
		const commandsHash = hashCommands(commands);
		const trust = id === null ? null : await readTrust(appDb, workspaceId, id);
		return {
			connectionRef,
			commands,
			commandsHash,
			approvedHash: trust?.commandsHash ?? null,
			approvedBy: trust?.approvedBy ?? null,
			approvedAt: trust?.approvedAt ?? null,
			trusted: trust !== null && trust.commandsHash === commandsHash,
			unavailable:
				deps.commandRunner === undefined
					? "Running a repository's commands is disabled — REPO_COMMANDS_ENABLED is off"
					: null,
		};
	}

	function requireGit(): GitDatasourcesServiceWithAdmin {
		if (deps.gitDatasources === undefined) {
			throw new ServiceError(
				ErrorCodes.Forbidden,
				config.HOST_FS_DISABLED
					? "Host filesystem access is disabled — HOST_FS_DISABLED is set"
					: "Git is disabled — GIT_ENABLED is off",
			);
		}
		return deps.gitDatasources;
	}

	function gitOptions(): GitOptions {
		return { timeoutMs: config.GIT_TIMEOUT_MS };
	}

	function audit(context: AuthContext, connectionRef: string) {
		return {
			workspaceId: context.workspace.id,
			userId: context.userId,
			connectionRef,
		};
	}

	/**
	 * The repository behind a `{ connectionRef }` payload. Every git
	 * action names its datasource the same way, and every one of them has
	 * to prove the datasource belongs to this workspace before running a
	 * process — socket authentication is not object authorization.
	 */
	async function requireRepo(
		workspaceId: string,
		payload: unknown,
	): Promise<{ entry: GitDatasourceEntry }> {
		const { connectionRef } = gitStatusRequestSchema.parse(payload);
		return {
			entry: await requireGit().requireEntry(workspaceId, connectionRef),
		};
	}

	function broadcastDocumentChanged(
		workspaceId: string,
		entry: {
			id: string;
			title: string;
			revision: number;
			updatedAt: string;
			origin?: DocumentOrigin | null;
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
				origin: entry.origin ?? null,
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
				// A file-backed document's artifact is the file, not the row:
				// the row exists so the live multiplayer state survives, and
				// the save is not finished until the file matches it. After
				// the database write, so a refused write leaves the row and
				// the disk both readable rather than the row silently ahead.
				if (result.document.origin !== null) {
					await writeDocumentToDisk(workspace.id, result.document);
				}
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
				// The root is reported only when it currently resolves inside
				// the allowlist, so the tab never shows a target it cannot
				// actually write to.
				let root: string | null = null;
				if (!hostFs.disabled) {
					root = await resolveExportTarget(
						{
							appDb,
							...(deps.gitDatasources !== undefined
								? { gitDatasources: deps.gitDatasources }
								: {}),
							hostFs,
						},
						workspace.id,
						request.connectionRef,
					)
						.then((target) => target.root)
						.catch(() => null);
				}
				return {
					runs: await listRuns(
						appDb,
						workspace.id,
						request.connectionRef,
						request.limit,
					),
					root,
					exportEnabled: !hostFs.disabled,
					gitEnabled: config.GIT_ENABLED,
				};
			}

			case "domain.export": {
				const request = domainExportRequestSchema.parse(payload);
				const run = () =>
					runExport(
						{
							appDb,
							connections,
							...(deps.gitDatasources !== undefined
								? { gitDatasources: deps.gitDatasources }
								: {}),
							hostFs,
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
						{
							appDb,
							connections,
							...(deps.gitDatasources !== undefined
								? { gitDatasources: deps.gitDatasources }
								: {}),
							hostFs,
						},
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
						const resolved = await resolveHostDirectory(request.path, hostFs);
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
				// A git datasource's sync target belongs to its repository, so
				// this writes `.datagripe/sync.yaml` rather than a row. The
				// repo stays the single answer to where its own dump goes.
				const repo =
					deps.gitDatasources === undefined
						? null
						: await deps.gitDatasources.entryFor(
								workspace.id,
								request.connectionRef,
							);
				if (repo === null) {
					await setExportPath(
						appDb,
						workspace.id,
						request.connectionRef,
						request.path,
					);
				} else {
					const relative = relativeToRepo(repo.repoPath, request.path);
					await writeSync(repo.repoPath, {
						version: 1,
						sync: {
							dir: relative,
							includeAccessReports:
								repo.sync?.sync.includeAccessReports ?? true,
							...(repo.sync?.sync.maxDataRows !== undefined
								? { maxDataRows: repo.sync.sync.maxDataRows }
								: {}),
						},
					});
					deps.gitDatasources?.invalidate(repo.repoPath);
				}
				// The connection list carries the path, so the caller gets the
				// updated datasource back rather than having to refetch.
				return { connections: await connections.listConnections(workspace) };
			}

			case "datasource.check-path": {
				const request = hostPathCheckRequestSchema.parse(payload);
				if (request.path.trim() === "") {
					return { ok: false, resolved: null, message: "Enter a directory" };
				}
				try {
					return {
						ok: true,
						resolved: await resolveHostDirectory(
							request.path,
							hostFs,
							"datasource path",
						),
						message: "allowed",
					};
				} catch (error) {
					return {
						ok: false,
						resolved: null,
						message:
							error instanceof Error ? error.message : "Path is not allowed",
					};
				}
			}

			case "datasource.set-paths": {
				const request = datasourcePathsSetRequestSchema.parse(payload);
				await withIdempotency(
					appDb,
					workspace.id,
					action,
					request.idempotencyKey,
					() => setDatasourcePaths(appDb, workspace.id, request),
				);
				// Same shape as `domain.set-export-path`: the paths ride on the
				// connection list, so the caller gets the datasource back
				// rather than having to refetch it.
				return { connections: await connections.listConnections(workspace) };
			}

			case "file.list": {
				const request = fileListRequestSchema.parse(payload);
				const root = await resolveDatasourcePath(
					workspace.id,
					request.connectionRef,
					request.pathId,
				);
				return { entries: await listDirectory(root, request.subPath) };
			}

			case "file.open": {
				const request = fileOpenRequestSchema.parse(payload);
				const root = await resolveDatasourcePath(
					workspace.id,
					request.connectionRef,
					request.pathId,
				);
				const onDisk = await readTextFile(root, request.filePath);
				const existing = await documents.getDocumentByOrigin(
					workspace.id,
					request.pathId,
					request.filePath,
				);
				if (existing === null) {
					const created = await documents.createFileDocument(workspace.id, {
						origin: {
							connectionRef: request.connectionRef,
							pathId: request.pathId,
							filePath: request.filePath,
						},
						title: request.filePath.split("/").pop() ?? request.filePath,
						content: onDisk.content,
						diskHash: onDisk.hash,
					});
					broadcastDocumentChanged(workspace.id, created, false);
					return { document: created, diskChanged: false, diskContent: null };
				}
				const synced = await documents.diskSyncState(workspace.id, existing.id);
				if (synced.hash === onDisk.hash) {
					return { document: existing, diskChanged: false, diskContent: null };
				}
				// The file moved under us. Adopting it is only safe when the
				// cached copy is still exactly what was last synced — otherwise
				// two people edited the same file two ways and picking one
				// silently is how the other one's work disappears.
				if (hashContent(existing.content) === synced.hash) {
					const adopted = await documents.adoptFromDisk(
						workspace.id,
						existing.id,
						onDisk.content,
						onDisk.hash,
					);
					broadcastDocumentChanged(workspace.id, adopted, false);
					return { document: adopted, diskChanged: false, diskContent: null };
				}
				return {
					document: existing,
					diskChanged: true,
					diskContent: onDisk.content,
				};
			}

			case "repo.commands": {
				const request = repoCommandsRequestSchema.parse(payload);
				const { entry } = await requireRepo(workspace.id, payload);
				return commandsState(
					workspace.id,
					request.connectionRef,
					entry.repoPath,
				);
			}

			case "repo.trust": {
				const request = repoTrustRequestSchema.parse(payload);
				requireCommandsEnabled();
				const { entry } = await requireRepo(workspace.id, payload);
				const id = idFromRef(request.connectionRef);
				if (id === null) {
					throw new ServiceError(ErrorCodes.BadRequest, "Not a git datasource");
				}
				if (!request.approve) {
					await clearTrust(appDb, workspace.id, id);
					return commandsState(
						workspace.id,
						request.connectionRef,
						entry.repoPath,
					);
				}
				const { commands } = await readCommands(entry.repoPath);
				const current = hashCommands(commands);
				// The client sends the hash it was shown. If the file moved
				// in between, what they approved is not what is on disk, and
				// approving it anyway is the whole hole this closes.
				if (current !== request.commandsHash) {
					throw new ServiceError(
						ErrorCodes.Conflict,
						"The command list changed while you were reading it — look again before approving",
					);
				}
				await setTrust(appDb, workspace.id, id, current, ctx.userId);
				log.audit("repo.trust", {
					workspaceId: workspace.id,
					userId: ctx.userId,
					connectionRef: request.connectionRef,
					commandsHash: current,
					commands: commands.map((command) => command.run.join(" ")),
				});
				return commandsState(
					workspace.id,
					request.connectionRef,
					entry.repoPath,
				);
			}

			case "repo.run": {
				const request = repoRunRequestSchema.parse(payload);
				const runner = requireCommandsEnabled();
				const { entry } = await requireRepo(workspace.id, payload);
				const id = idFromRef(request.connectionRef);
				if (id === null) {
					throw new ServiceError(ErrorCodes.BadRequest, "Not a git datasource");
				}
				const { commands } = await readCommands(entry.repoPath);
				const current = hashCommands(commands);
				const trust = await readTrust(appDb, workspace.id, id);
				// Re-checked here and not only in the UI: the list on disk
				// now is what would run, and it may have moved since the
				// panel rendered.
				if (trust === null || trust.commandsHash !== current) {
					throw new ServiceError(
						ErrorCodes.Forbidden,
						trust === null
							? "Nobody has approved this repository's commands yet"
							: "This repository's commands changed since they were approved — review and approve them again",
					);
				}
				const command = commands.find(
					(candidate) => candidate.name === request.name,
				);
				if (command === undefined) {
					throw new ServiceError(
						ErrorCodes.NotFound,
						`No command called '${request.name}' in this repository`,
					);
				}
				const handle = await runner.start(entry.repoPath, command, {
					workspaceId: workspace.id,
					userId: ctx.userId,
					connectionRef: request.connectionRef,
				});
				return {
					runId: handle.runId,
					connectionRef: request.connectionRef,
					name: command.name,
					argv: handle.argv,
					cwd: handle.cwd,
				};
			}

			case "repo.run.cancel": {
				const request = repoRunCancelRequestSchema.parse(payload);
				const runner = requireCommandsEnabled();
				return { cancelled: runner.stop(request.runId, "cancelled") };
			}

			case "git.datasource.add": {
				const service = requireGit();
				const request = gitDatasourceAddRequestSchema.parse(payload);
				const created = await service.add(workspace, ctx.userId, request);
				// The datasource list is how the sidebar learns about the new
				// sections, so everybody in the project gets told.
				hub.broadcastToWorkspace(workspace.id, {
					version: 1,
					kind: "event",
					eventId: crypto.randomUUID(),
					topic: "connections.changed",
					occurredAt: new Date().toISOString(),
					payload: { connectionRef: created.id },
				});
				return created;
			}

			case "git.datasource.remove": {
				const service = requireGit();
				const request = gitDatasourceRemoveRequestSchema.parse(payload);
				await service.remove(
					workspace.id,
					request.connectionRef,
					request.deleteCheckout,
				);
				hub.broadcastToWorkspace(workspace.id, {
					version: 1,
					kind: "event",
					eventId: crypto.randomUUID(),
					topic: "connections.changed",
					occurredAt: new Date().toISOString(),
					payload: { connectionRef: request.connectionRef },
				});
				return { removed: true };
			}

			case "git.datasource.reload": {
				const service = requireGit();
				const request = gitDatasourceReloadRequestSchema.parse(payload);
				const entry = await service.requireEntry(
					workspace.id,
					request.connectionRef,
				);
				service.invalidate(entry.repoPath);
				return (
					(await service.describe(workspace.id, request.connectionRef)) ?? {}
				);
			}

			case "git.datasource.set-options": {
				const request = gitDatasourceOptionsRequestSchema.parse(payload);
				const service = requireGit();
				const updated = await withIdempotency(
					appDb,
					workspace.id,
					action,
					request.idempotencyKey,
					() => service.setOptions(workspace.id, request),
				);
				// The connection list carries `readOnly` and `showAllSchemas`,
				// and the tree reads both, so everybody gets the new one.
				hub.broadcastToWorkspace(workspace.id, {
					version: 1,
					kind: "event",
					eventId: crypto.randomUUID(),
					topic: "connections.changed",
					occurredAt: new Date().toISOString(),
					payload: { connectionRef: request.connectionRef },
				});
				return updated;
			}

			case "git.status": {
				const { entry } = await requireRepo(workspace.id, payload);
				return gitRepo.status(entry.repoPath, gitOptions());
			}

			case "git.stage": {
				const request = gitStageRequestSchema.parse(payload);
				const { entry } = await requireRepo(workspace.id, payload);
				return gitRepo.stage(
					entry.repoPath,
					request.paths,
					request.staged,
					gitOptions(),
					audit(ctx, request.connectionRef),
				);
			}

			case "git.commit": {
				const request = gitCommitRequestSchema.parse(payload);
				const { entry } = await requireRepo(workspace.id, payload);
				return gitRepo.commit(
					entry.repoPath,
					request.message,
					request.paths,
					gitOptions(),
					audit(ctx, request.connectionRef),
				);
			}

			case "git.push": {
				const request = gitPushRequestSchema.parse(payload);
				const { entry } = await requireRepo(workspace.id, payload);
				return gitRepo.push(
					entry.repoPath,
					request.setUpstream,
					gitOptions(),
					audit(ctx, request.connectionRef),
				);
			}

			case "git.pull": {
				const request = gitPullRequestSchema.parse(payload);
				const { entry } = await requireRepo(workspace.id, payload);
				// Offering to fast-forward over somebody's unsaved work is not
				// a service. The incoming file list is already known, and so is
				// which cached documents are ahead of their file.
				const incoming = new Set(
					await gitRepo.incomingPaths(entry.repoPath, gitOptions()),
				);
				const blocked = (
					await dirtyOriginPaths(
						appDb,
						workspace.id,
						request.connectionRef,
						entry.repoPath,
					)
				).filter((file) => incoming.has(file));
				if (blocked.length > 0) {
					throw new ServiceError(
						ErrorCodes.Conflict,
						`The pull would change ${blocked.join(", ")}, which ${blocked.length === 1 ? "has" : "have"} unsaved edits here. Save or discard first.`,
					);
				}
				const result = await gitRepo.pull(
					entry.repoPath,
					gitOptions(),
					audit(ctx, request.connectionRef),
				);
				if (result.headMoved) {
					// Reload the config: a `.datagripe/` file may have changed,
					// and the sections come off the connection list.
					requireGit().invalidate(entry.repoPath);
					hub.broadcastToWorkspace(workspace.id, {
						version: 1,
						kind: "event",
						eventId: crypto.randomUUID(),
						topic: "repo.changed",
						occurredAt: new Date().toISOString(),
						payload: {
							connectionRef: request.connectionRef,
							changedPaths: result.changedPaths,
							configChanged: result.changedPaths.some(isDatagripeFile),
						},
					});
				}
				return result;
			}

			case "datasource.export-config": {
				const request = exportConfigRequestSchema.parse(payload);
				return runExportConfig(
					{
						appDb,
						connections,
						hostFs,
						gitOptions: gitOptions(),
					},
					workspace,
					ctx.userId,
					request,
				);
			}

			case "domain.git": {
				if (!config.GIT_ENABLED) {
					throw new ServiceError(
						ErrorCodes.Forbidden,
						"Committing is disabled — GIT_ENABLED is off",
					);
				}
				const request = domainGitRequestSchema.parse(payload);
				// The same target the export writes to, so a commit can never
				// be scoped to a different directory than the run it follows.
				const { root } = await resolveExportTarget(
					{
						appDb,
						...(deps.gitDatasources !== undefined
							? { gitDatasources: deps.gitDatasources }
							: {}),
						hostFs,
					},
					workspace.id,
					request.connectionRef,
				);
				const result = await runGit(
					root,
					request.operation,
					request.message,
					gitOptions(),
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
