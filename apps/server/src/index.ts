import path from "node:path";
import { TABLE_PAGE_MAX_ROWS } from "@datagripe/contracts";
import {
	MysqlAdapter,
	PostgresAdapter,
	RedisAdapter,
	SqliteAdapter,
} from "@datagripe/database-adapters";
import { serve } from "bun";
import { defaultWorkspaceFor, workspaceForMember } from "./auth/accounts";
import { createSessionStore } from "./auth/sessions";
import { ensureLocalWorkspace } from "./bootstrap";
import { loadConfig, resolveRepoPath } from "./config";
import { loadPredefinedConnections } from "./connections/predefined";
import { createConnectionsService } from "./connections/service";
import { createKeyring } from "./crypto/keyring";
import {
	type EmbeddedPgHandle,
	startEmbeddedPostgres,
} from "./db/app/embedded";
import { migrate } from "./db/app/migrate";
import { createAppDb } from "./db/app/pool";
import { createDocumentsService } from "./documents/service";
import { parseHostRoots } from "./domains/paths";
import { createExecutionRegistry } from "./execution/registry";
import { CommandRunner } from "./git/runner";
import { createGitDatasourcesService } from "./git/service";
import { createAuthRoutes, sessionFromRequest } from "./http/auth";
import { errorResponse } from "./http/errors";
import { log } from "./log";
import type { McpDeps } from "./mcp/context";
import { createMcpRoute } from "./mcp/route";
import { createMcpService } from "./mcp/service";
import { PresenceTracker } from "./multiplayer/presence";
import { ViewBroadcastThrottle } from "./multiplayer/views";
import { createRateLimiter } from "./security/rateLimit";
import { createSsrfPolicy } from "./security/ssrf";
import { createDispatcher } from "./ws/dispatch";
import { createWebsocketHandler, type SocketData } from "./ws/handler";
import { SocketHub } from "./ws/hub";

const config = await loadConfig();

// Embedded mode: boot the managed PostgreSQL cluster first, then keep its
// schema current automatically. External mode expects `bun run db:migrate`.
let embeddedPg: EmbeddedPgHandle | null = null;
if (config.DATABASE_MODE === "embedded") {
	embeddedPg = await startEmbeddedPostgres(config);
}
const appDb = createAppDb(
	embeddedPg?.url ?? (config.APP_DATABASE_URL as string),
);
if (embeddedPg !== null) {
	await migrate(appDb);
}

// Direct-in mode: a single implicit identity, no accounts or cookies.
const localAuth = config.AUTH_DISABLED
	? await ensureLocalWorkspace(appDb)
	: null;

// Single-binary / desktop deployments serve the built web app from
// WEB_STATIC_DIR; development uses the vite dev server instead.
const staticDir =
	config.WEB_STATIC_DIR === undefined
		? null
		: resolveRepoPath(config.WEB_STATIC_DIR);
/** Serve built web assets with SPA fallback to index.html. */
async function serveStatic(
	root: string,
	pathname: string,
	requestId: string,
): Promise<Response> {
	const relative = pathname === "/" ? "index.html" : pathname.slice(1);
	const resolved = path.resolve(root, relative);
	if (!resolved.startsWith(`${root}${path.sep}`) && resolved !== root) {
		return errorResponse(403, "FORBIDDEN", "Forbidden", requestId);
	}
	const file = Bun.file(resolved);
	if (await file.exists()) {
		return new Response(file);
	}
	// Directories and unknown paths fall through to the SPA entry point.
	return new Response(Bun.file(path.join(root, "index.html")));
}

const keyring = createKeyring(new Map([[1, config.CONNECTION_ENCRYPTION_KEY]]));
const predefined = await loadPredefinedConnections(config);
const adapters = {
	postgres: new PostgresAdapter(),
	mysql: new MysqlAdapter(),
	sqlite: new SqliteAdapter(),
	redis: new RedisAdapter(),
};
const hub = new SocketHub();
const presence = new PresenceTracker();
const viewThrottle = new ViewBroadcastThrottle();
const sessions = createSessionStore(appDb);
const rateLimiter = createRateLimiter({
	"auth.login.ip": { capacity: 30, refillPerMinute: 30 },
	"auth.login.email": { capacity: 5, refillPerMinute: 5 },
	"connection.test": { capacity: 10, refillPerMinute: 10 },
	"execution.start": { capacity: 30, refillPerMinute: 30 },
	"schema.children": { capacity: 120, refillPerMinute: 120 },
	// Paging, sorting and refreshing a grid are all reads; a live table
	// view fires several per interaction.
	"table.rows": { capacity: 120, refillPerMinute: 240 },
	"table.mutate": { capacity: 60, refillPerMinute: 60 },
	// One describe fills every object-view tab, so the budget is per tab
	// opened rather than per tab switched.
	"object.describe": { capacity: 60, refillPerMinute: 120 },
	// Previews are cheap and frequent while editing; applies are neither.
	"object.alter": { capacity: 40, refillPerMinute: 60 },
	// Per token, not per user (docs/spec/mcp.md): an agent in a loop must
	// not be able to outrun the people sharing the datasource. The query
	// budget matches what a person gets on execution.start.
	"mcp.tools.call": { capacity: 120, refillPerMinute: 120 },
	"mcp.query": { capacity: 30, refillPerMinute: 30 },
});

/**
 * Above this many estimated rows the table view's footer count comes
 * from planner statistics: COUNT(*) on a 40M-row table costs seconds to
 * produce a number nobody reads to the digit.
 */
const TABLE_COUNT_ESTIMATE_THRESHOLD = 100_000;

const ssrf = createSsrfPolicy(
	config.TARGET_HOST_ALLOWLIST,
	config.SSRF_DISABLED,
);

/**
 * Git datasources (docs/spec/git-datasources.md). Created even when off,
 * so the refusal carries the reason — the buttons are absent, but a
 * request that goes around the UI gets told which switch to look at.
 */
const gitDatasources = createGitDatasourcesService({
	appDb,
	keyring,
	ssrf,
	env: Bun.env,
	reposDir: config.GIT_REPOS_DIR,
	gitOptions: { timeoutMs: config.GIT_TIMEOUT_MS },
	cloneOptions: { timeoutMs: config.GIT_CLONE_TIMEOUT_MS },
	enabled: config.GIT_ENABLED && !config.HOST_FS_DISABLED,
	disabledReason: config.HOST_FS_DISABLED
		? "Host filesystem access is disabled — HOST_FS_DISABLED is set"
		: "Git is disabled — GIT_ENABLED is off",
});

const connections = createConnectionsService({
	appDb,
	keyring,
	adapters,
	predefined,
	gitDatasources,
	ssrf,
	tableLimits: {
		timeoutMs: config.QUERY_TIMEOUT_MS,
		maxRows: Math.min(config.QUERY_MAX_ROWS, TABLE_PAGE_MAX_ROWS),
		estimateAboveRows: TABLE_COUNT_ESTIMATE_THRESHOLD,
	},
});
const executions = createExecutionRegistry({
	adapters,
	appDb,
	limits: {
		timeoutMs: config.QUERY_TIMEOUT_MS,
		maxRows: config.QUERY_MAX_ROWS,
		maxBytes: config.QUERY_MAX_BYTES,
		maxConcurrentPerUser: config.MAX_CONCURRENT_QUERIES_PER_USER,
	},
	resolveConnection: (workspace, id) =>
		connections.resolveForExecution(workspace, id),
	emit: (target, executionId, topic, sequence, payload) => {
		hub.broadcastExecution(target.workspaceId, {
			version: 1,
			kind: "event",
			eventId: crypto.randomUUID(),
			topic,
			executionId,
			sequence,
			occurredAt: new Date().toISOString(),
			payload,
		});
	},
});
const documents = createDocumentsService(appDb);

/**
 * MCP (docs/spec/mcp.md). One endpoint per project, off in every project
 * until an owner turns it on; `MCP_ENABLED` is the deployment's kill
 * switch, and when it is off the route and the panel are both absent.
 */
const mcpDeps: McpDeps = {
	appDb,
	config,
	connections,
	documents,
	executions,
	rateLimiter,
	hostFs: {
		roots: parseHostRoots(
			config.HOST_FS_ROOTS === ""
				? config.DOMAIN_EXPORT_ROOTS
				: config.HOST_FS_ROOTS,
		),
		disabled: config.HOST_FS_DISABLED,
	},
	...(config.GIT_ENABLED && !config.HOST_FS_DISABLED ? { gitDatasources } : {}),
};
const mcp = config.MCP_ENABLED ? createMcpService(mcpDeps) : null;
const mcpRoute = config.MCP_ENABLED ? createMcpRoute(mcpDeps) : null;

/**
 * The command runner (docs/spec/repo-commands.md). Output is streamed to
 * the whole workspace rather than to the socket that pressed the button:
 * a run that starts a database is something everybody in the project is
 * affected by, and the person who pressed it may well close the tab.
 */
const commandRunner = new CommandRunner({
	maxTimeoutMs: config.REPO_COMMAND_TIMEOUT_MS,
	defaultTimeoutMs: config.REPO_COMMAND_DEFAULT_TIMEOUT_MS,
	onOutput: (target, stream, chunk) =>
		hub.broadcastToWorkspace(target.workspaceId, {
			version: 1,
			kind: "event",
			eventId: crypto.randomUUID(),
			topic: "repo.run.output",
			occurredAt: new Date().toISOString(),
			payload: { runId: target.runId, stream, chunk },
		}),
	onExit: (target, exitCode, killed, reason) =>
		hub.broadcastToWorkspace(target.workspaceId, {
			version: 1,
			kind: "event",
			eventId: crypto.randomUUID(),
			topic: "repo.run.exit",
			occurredAt: new Date().toISOString(),
			payload: { runId: target.runId, exitCode, killed, reason },
		}),
});
const dispatch = createDispatcher({
	appDb,
	connections,
	documents,
	executions,
	presence,
	viewThrottle,
	hub,
	rateLimiter,
	config,
	// Absent, not present-and-disabled: the dispatcher's own gate reads
	// "is this here", and there is one place that decides.
	...(config.GIT_ENABLED && !config.HOST_FS_DISABLED ? { gitDatasources } : {}),
	// A separate switch on purpose: git datasources read and write files,
	// this executes a program from a repository.
	...(config.REPO_COMMANDS_ENABLED &&
	config.GIT_ENABLED &&
	!config.HOST_FS_DISABLED
		? { commandRunner }
		: {}),
	...(mcp === null ? {} : { mcp }),
});
const auth = createAuthRoutes({
	appDb,
	config,
	sessions,
	rateLimiter,
	closeSocketsForSession: (sessionId) => hub.closeForSession(sessionId),
	localAuth,
});

const server = serve<SocketData>({
	port: config.PORT,

	routes: {
		// Liveness only — no dependency details (basic.md §9).
		"/health": () => Response.json({ ok: true }),

		"/api/session": {
			GET: (req: Request) => auth.session(req),
		},
		"/api/auth/signup": {
			POST: (req: Request) => auth.signup(req),
		},
		"/api/auth/login": {
			POST: (req: Request) => auth.login(req),
		},
		"/api/auth/logout": {
			POST: (req: Request) => auth.logout(req),
		},
	},

	async fetch(req, server) {
		const url = new URL(req.url);
		const requestId = req.headers.get("x-request-id") ?? crypto.randomUUID();

		if (url.pathname === "/ws") {
			// Origin validation: only accept upgrades from the configured web origin.
			const origin = req.headers.get("origin");
			if (origin !== config.WEB_ORIGIN) {
				log.warn("websocket upgrade rejected: bad origin", {
					origin,
					requestId,
				});
				return errorResponse(403, "FORBIDDEN", "Origin not allowed", requestId);
			}

			// Session-cookie authentication (browser WebSocket APIs cannot
			// attach authorization headers).
			const session = await sessionFromRequest(sessions, req, localAuth);
			if (session === null) {
				return errorResponse(
					401,
					"UNAUTHORIZED",
					"A valid session is required",
					requestId,
				);
			}
			// Optional workspace switch target; falls back to the default. In
			// direct-in mode the stub workspace is the only one and has no
			// membership row, so skip membership resolution entirely.
			const requested = url.searchParams.get("workspace");
			const workspace =
				localAuth !== null
					? { ...localAuth.workspace, role: "owner" as const }
					: requested !== null
						? ((await workspaceForMember(appDb, session.userId, requested)) ??
							(await defaultWorkspaceFor(appDb, session.userId)))
						: await defaultWorkspaceFor(appDb, session.userId);
			if (workspace === null) {
				return errorResponse(
					403,
					"FORBIDDEN",
					"Account has no workspace",
					requestId,
				);
			}
			const userRow = await appDb<{ email: string }[]>`
				SELECT email FROM users WHERE id = ${session.userId}
			`;

			if (
				server.upgrade(req, {
					data: {
						requestId,
						userId: session.userId,
						email: userRow[0]?.email ?? "",
						sessionId: session.id,
						workspace: {
							id: workspace.id,
							name: workspace.name,
							defaultConnectionRef: workspace.defaultConnectionRef,
						},
						role: workspace.role,
					},
				})
			) {
				return undefined;
			}
			return errorResponse(
				400,
				"BAD_REQUEST",
				"WebSocket upgrade failed",
				requestId,
			);
		}

		// `/mcp/<projectId>`: the project id is in the path because the
		// scope is the project. Two projects mean two entries in an MCP
		// client's config, and no tool has to ask which one was meant.
		const mcpPath = /^\/mcp\/([0-9a-fA-F-]{36})\/?$/.exec(url.pathname);
		if (mcpPath !== null && mcpRoute !== null) {
			return mcpRoute(req, mcpPath[1] as string);
		}

		if (staticDir !== null) {
			return serveStatic(staticDir, url.pathname, requestId);
		}

		return errorResponse(404, "NOT_FOUND", "Not found", requestId);
	},

	websocket: createWebsocketHandler(dispatch, hub, presence),
});

async function shutdown() {
	log.info("shutting down");
	server.stop();
	sessions.stopSweep();
	rateLimiter.stop();
	await Promise.all(Object.values(adapters).map((a) => a.close()));
	await appDb.close();
	await embeddedPg?.stop();
	process.exit(0);
}
process.on("SIGINT", () => void shutdown());
process.on("SIGTERM", () => void shutdown());

log.info("server listening", {
	port: server.port,
	env: config.NODE_ENV,
	predefinedConnections: predefined.size,
});
