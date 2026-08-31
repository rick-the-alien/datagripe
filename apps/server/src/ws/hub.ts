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

	broadcast(event: ServerEvent): void {
		const text = JSON.stringify(event);
		for (const ws of this.sockets) {
			ws.send(text);
		}
	}

	get size(): number {
		return this.sockets.size;
	}
}
