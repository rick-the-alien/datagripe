import { PostgresAdapter } from "@datagripe/database-adapters";
import { serve } from "bun";
import { ensureLocalWorkspace } from "./bootstrap";
import { loadConfig } from "./config";
import { loadPredefinedConnections } from "./connections/predefined";
import { createConnectionsService } from "./connections/service";
import { createKeyring } from "./crypto/keyring";
import { createAppDb } from "./db/app/pool";
import { errorResponse } from "./http/errors";
import { log } from "./log";
import { createDispatcher } from "./ws/dispatch";
import { createWebsocketHandler, type SocketData } from "./ws/handler";

const config = await loadConfig();
const appDb = createAppDb(config);

// Pre-auth stub (Phase 4): one local user/workspace owns all rows.
const workspace = await ensureLocalWorkspace(appDb);
const keyring = createKeyring(new Map([[1, config.CONNECTION_ENCRYPTION_KEY]]));
const predefined = await loadPredefinedConnections(config);
const adapter = new PostgresAdapter();

const connections = createConnectionsService({
	appDb,
	keyring,
	adapter,
	workspace,
	predefined,
});
const dispatch = createDispatcher({ appDb, workspace, connections });

const server = serve<SocketData>({
	port: config.PORT,

	routes: {
		// Liveness only — no dependency details (basic.md §9).
		"/health": () => Response.json({ ok: true }),

		// Session bootstrap stub; real auth provider integration lands in Phase 4.
		"/api/session": () =>
			Response.json({
				user: null,
				wsUrl: `ws://localhost:${config.PORT}/ws`,
			}),
	},

	fetch(req, server) {
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
			if (server.upgrade(req, { data: { requestId } })) {
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

	websocket: createWebsocketHandler(dispatch),
});

async function shutdown() {
	log.info("shutting down");
	server.stop();
	await adapter.close();
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
