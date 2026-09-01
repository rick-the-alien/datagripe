import { ErrorCodes } from "@datagripe/contracts/errors";
import {
	clientRequestSchema,
	type ServerResponse,
} from "@datagripe/contracts/ws";
import { InvalidIntrospectionPathError } from "@datagripe/database-adapters";
import { ZodError } from "zod";
import { ServiceError } from "../connections/service";
import { DocumentConflictError } from "../documents/service";
import { log } from "../log";
import type { PresenceTracker } from "../multiplayer/presence";
import { SsrfBlockedError } from "../security/ssrf";
import type { Dispatch } from "./dispatch";
import type { SocketHub } from "./hub";

export type SocketData = {
	requestId: string;
	userId: string;
	email: string;
	sessionId: string;
	workspace: { id: string; name: string; defaultConnectionRef: string | null };
	role: "owner" | "editor" | "viewer";
};

type ServerWebSocket = Bun.ServerWebSocket<SocketData>;

function respond(ws: ServerWebSocket, response: ServerResponse): void {
	ws.send(JSON.stringify(response));
}

function failure(
	ws: ServerWebSocket,
	requestId: string,
	code: string,
	message: string,
	details?: unknown,
): void {
	respond(ws, {
		version: 1,
		kind: "response",
		requestId,
		ok: false,
		error: {
			code,
			message,
			requestId: ws.data.requestId,
			...(details !== undefined ? { details } : {}),
		},
	});
}

/**
 * WebSocket handler: validates the protocol envelope, then dispatches the
 * action. Auth binding and per-object authorization land in Phase 4 with
 * the workspace session.
 */
export function createWebsocketHandler(
	dispatch: Dispatch,
	hub: SocketHub,
	presence: PresenceTracker,
) {
	function broadcastPresence(workspaceId: string): void {
		hub.broadcastToWorkspace(workspaceId, {
			version: 1,
			kind: "event",
			eventId: crypto.randomUUID(),
			topic: "presence.update",
			occurredAt: new Date().toISOString(),
			payload: { users: presence.list(workspaceId) },
		});
	}

	return {
		open(ws: ServerWebSocket) {
			hub.add(ws);
			const changed = presence.join(ws.data.workspace.id, {
				userId: ws.data.userId,
				email: ws.data.email,
			});
			if (changed !== null) {
				broadcastPresence(ws.data.workspace.id);
			}
			log.info("websocket connected", { requestId: ws.data.requestId });
		},

		message(ws: ServerWebSocket, message: string | Buffer) {
			const text =
				typeof message === "string" ? message : message.toString("utf8");

			let parsed: unknown;
			try {
				parsed = JSON.parse(text);
			} catch {
				failure(ws, "unknown", ErrorCodes.BadRequest, "Malformed message");
				return;
			}

			const result = clientRequestSchema.safeParse(parsed);
			if (!result.success) {
				failure(
					ws,
					"unknown",
					ErrorCodes.BadRequest,
					"Invalid protocol envelope",
				);
				return;
			}

			const request = result.data;
			void (async () => {
				try {
					const payload = await dispatch(
						{
							userId: ws.data.userId,
							sessionId: ws.data.sessionId,
							workspace: ws.data.workspace,
							role: ws.data.role,
						},
						request.action,
						request.payload,
					);
					// Row payloads flow only to subscribed sockets (6d).
					if (request.action === "execution.start") {
						const executionId = (payload as { executionId?: string })
							?.executionId;
						if (typeof executionId === "string") {
							hub.subscribeToExecution(executionId, ws);
						}
					}
					if (request.action === "execution.subscribe") {
						const subscribePayload = request.payload as {
							executionId?: string;
						};
						if (typeof subscribePayload.executionId === "string") {
							hub.subscribeToExecution(subscribePayload.executionId, ws);
						}
					}
					respond(ws, {
						version: 1,
						kind: "response",
						requestId: request.requestId,
						ok: true,
						payload,
					});
				} catch (error) {
					if (error instanceof DocumentConflictError) {
						failure(ws, request.requestId, error.code, error.message, {
							document: error.current,
						});
					} else if (error instanceof ServiceError) {
						failure(ws, request.requestId, error.code, error.message);
					} else if (error instanceof ZodError) {
						failure(
							ws,
							request.requestId,
							ErrorCodes.BadRequest,
							"Invalid action payload",
							error.issues.map((issue) => ({
								path: issue.path.join("."),
								message: issue.message,
							})),
						);
					} else if (error instanceof InvalidIntrospectionPathError) {
						failure(
							ws,
							request.requestId,
							ErrorCodes.BadRequest,
							error.message,
						);
					} else if (error instanceof SsrfBlockedError) {
						failure(ws, request.requestId, error.code, error.message);
					} else {
						log.error("action failed", {
							requestId: ws.data.requestId,
							action: request.action,
							error: error instanceof Error ? error.message : String(error),
						});
						failure(
							ws,
							request.requestId,
							ErrorCodes.Internal,
							"Internal error",
						);
					}
				}
			})();
		},

		close(ws: ServerWebSocket) {
			hub.remove(ws);
			const changed = presence.leave(ws.data.workspace.id, ws.data.userId);
			if (changed !== null) {
				broadcastPresence(ws.data.workspace.id);
			}
			log.info("websocket disconnected", { requestId: ws.data.requestId });
		},
	};
}
