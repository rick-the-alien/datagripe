import type { ServerEvent } from "@datagripe/contracts/ws";
import type { SocketData } from "./handler";

/**
 * Live socket inventory. Execution events broadcast to every connected
 * socket of the (single, pre-auth) workspace; events carry executionId
 * so clients route them. Per-user targeting arrives with Phase 4 auth.
 */
export class SocketHub {
	private readonly sockets = new Set<Bun.ServerWebSocket<SocketData>>();

	add(ws: Bun.ServerWebSocket<SocketData>): void {
		this.sockets.add(ws);
	}

	remove(ws: Bun.ServerWebSocket<SocketData>): void {
		this.sockets.delete(ws);
	}

	broadcast(userId: string, event: ServerEvent): void {
		const text = JSON.stringify(event);
		for (const ws of this.sockets) {
			if (ws.data.userId === userId) {
				ws.send(text);
			}
		}
	}

	/** Close every socket bound to a revoked/expired session. */
	closeForSession(sessionId: string): void {
		for (const ws of this.sockets) {
			if (ws.data.sessionId === sessionId) {
				ws.close(1000, "session ended");
			}
		}
	}

	get size(): number {
		return this.sockets.size;
	}
}
