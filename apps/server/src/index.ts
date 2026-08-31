import { serve } from "bun";
import { loadConfig } from "./config";
import { errorResponse } from "./http/errors";
import { log } from "./log";
import { type SocketData, websocketHandler } from "./ws/handler";

const config = await loadConfig();

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

	websocket: websocketHandler,
});

log.info("server listening", {
	port: server.port,
	env: config.NODE_ENV,
});
