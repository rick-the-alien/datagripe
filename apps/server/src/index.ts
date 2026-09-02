import {
	MysqlAdapter,
	PostgresAdapter,
	RedisAdapter,
	SqliteAdapter,
} from "@datagripe/database-adapters";
import { serve } from "bun";
import { defaultWorkspaceFor, workspaceForMember } from "./auth/accounts";
import { createSessionStore } from "./auth/sessions";
import { loadConfig } from "./config";
import { loadPredefinedConnections } from "./connections/predefined";
import { createConnectionsService } from "./connections/service";
import { createKeyring } from "./crypto/keyring";
import { createAppDb } from "./db/app/pool";
import { createDocumentsService } from "./documents/service";
import { createExecutionRegistry } from "./execution/registry";
import { createAuthRoutes, sessionFromRequest } from "./http/auth";
import { errorResponse } from "./http/errors";
import { log } from "./log";
import { PresenceTracker } from "./multiplayer/presence";
import { ViewBroadcastThrottle } from "./multiplayer/views";
import { createRateLimiter } from "./security/rateLimit";
import { createSsrfPolicy } from "./security/ssrf";
import { createDispatcher } from "./ws/dispatch";
import { createWebsocketHandler, type SocketData } from "./ws/handler";
import { SocketHub } from "./ws/hub";

const config = await loadConfig();
const appDb = createAppDb(config);
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
});

const connections = createConnectionsService({
	appDb,
	keyring,
	adapters,
	predefined,
	ssrf: createSsrfPolicy(config.TARGET_HOST_ALLOWLIST, config.SSRF_DISABLED),
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
const dispatch = createDispatcher({
	appDb,
	connections,
	documents,
	executions,
	presence,
	viewThrottle,
	hub,
	rateLimiter,
});
const auth = createAuthRoutes({
	appDb,
	config,
	sessions,
	rateLimiter,
	closeSocketsForSession: (sessionId) => hub.closeForSession(sessionId),
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
			const session = await sessionFromRequest(sessions, req);
			if (session === null) {
				return errorResponse(
					401,
					"UNAUTHORIZED",
					"A valid session is required",
					requestId,
				);
			}
			// Optional workspace switch target; falls back to the default.
			const requested = url.searchParams.get("workspace");
			const workspace =
				requested !== null
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
	process.exit(0);
}
process.on("SIGINT", () => void shutdown());
process.on("SIGTERM", () => void shutdown());

log.info("server listening", {
	port: server.port,
	env: config.NODE_ENV,
	predefinedConnections: predefined.size,
});
