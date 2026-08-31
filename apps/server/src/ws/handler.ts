import { ErrorCodes } from "@datagripe/contracts/errors";
import {
	clientRequestSchema,
	type ServerResponse,
} from "@datagripe/contracts/ws";
import { log } from "../log";

export type SocketData = {
	requestId: string;
};

type ServerWebSocket = Bun.ServerWebSocket<SocketData>;

function respond(ws: ServerWebSocket, response: ServerResponse): void {
	ws.send(JSON.stringify(response));
}

/**
 * Phase 0 WebSocket handler: validates the protocol envelope and
 * rejects every action as unimplemented. Auth binding, action dispatch,
 * and authorization land with the workspace session in later phases.
 */
export const websocketHandler = {
	open(ws: ServerWebSocket) {
		log.info("websocket connected", { requestId: ws.data.requestId });
	},

	message(ws: ServerWebSocket, message: string | Buffer) {
		const text =
			typeof message === "string" ? message : message.toString("utf8");

		let parsed: unknown;
		try {
			parsed = JSON.parse(text);
		} catch {
			respond(ws, {
				version: 1,
				kind: "response",
				requestId: "unknown",
				ok: false,
				error: {
					code: ErrorCodes.BadRequest,
					message: "Malformed message",
					requestId: ws.data.requestId,
				},
			});
			return;
		}

		const result = clientRequestSchema.safeParse(parsed);
		if (!result.success) {
			respond(ws, {
				version: 1,
				kind: "response",
				requestId: "unknown",
				ok: false,
				error: {
					code: ErrorCodes.BadRequest,
					message: "Invalid protocol envelope",
					requestId: ws.data.requestId,
				},
			});
			return;
		}

		respond(ws, {
			version: 1,
			kind: "response",
			requestId: result.data.requestId,
			ok: false,
			error: {
				code: ErrorCodes.NotFound,
				message: `Action '${result.data.action}' is not implemented yet`,
				requestId: ws.data.requestId,
			},
		});
	},

	close(ws: ServerWebSocket) {
		log.info("websocket disconnected", { requestId: ws.data.requestId });
	},
};
