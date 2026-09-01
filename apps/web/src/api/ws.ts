import {
	type ClientAction,
	type ServerEvent,
	serverEventSchema,
	serverResponseSchema,
	WS_PROTOCOL_VERSION,
} from "@datagripe/contracts/ws";

/**
 * Multiplexed workspace WebSocket client (docs/initial_idea.md §9–10):
 * one socket per browser workspace; every request carries a requestId
 * and is correlated to its response. Sends are queued until the socket
 * opens; pending requests are rejected on close and the socket
 * reconnects with a fixed delay.
 */

export type WsRequestFn = <T>(
	action: ClientAction,
	payload: unknown,
) => Promise<T>;

type PendingRequest = {
	resolve: (payload: unknown) => void;
	reject: (error: Error) => void;
	timer: ReturnType<typeof setTimeout>;
};

const REQUEST_TIMEOUT_MS = 15_000;
const RECONNECT_DELAY_MS = 1_000;

/** WS action failure carrying the protocol error code and details. */
export class WsError extends Error {
	readonly code: string;
	readonly details: unknown;

	constructor(code: string, message: string, details?: unknown) {
		super(message);
		this.name = "WsError";
		this.code = code;
		this.details = details;
	}
}

export class WsClient {
	private socket: WebSocket | null = null;
	private started = false;
	private workspaceId: string | null = null;
	private readonly pending = new Map<string, PendingRequest>();
	private readonly queue: Array<() => void> = [];
	private readonly openListeners = new Set<() => void>();
	private readonly eventListeners = new Set<(event: ServerEvent) => void>();

	/** Connect once; subsequent calls are no-ops. Reconnects automatically. */
	connect(workspaceId?: string | null): void {
		if (workspaceId !== undefined) {
			this.workspaceId = workspaceId;
		}
		if (this.started) {
			return;
		}
		this.started = true;
		this.open();
	}

	/** Switch workspaces: close the socket; the reconnect binds the new
	 * workspace and every onOpen listener rescopes. */
	setWorkspace(workspaceId: string): void {
		if (workspaceId === this.workspaceId) {
			return;
		}
		this.workspaceId = workspaceId;
		if (this.started) {
			this.socket?.close();
		}
	}

	/** Stop reconnecting and close the socket (logout, session expiry). */
	disconnect(): void {
		this.started = false;
		this.socket?.close();
		this.socket = null;
	}

	/** Called on every (re)open — re-run bootstrap loads here. */
	onOpen(listener: () => void): () => void {
		this.openListeners.add(listener);
		return () => this.openListeners.delete(listener);
	}

	/** Server events (execution lifecycle). */
	onEvent(listener: (event: ServerEvent) => void): () => void {
		this.eventListeners.add(listener);
		return () => this.eventListeners.delete(listener);
	}

	get isOpen(): boolean {
		return this.socket?.readyState === WebSocket.OPEN;
	}

	request: WsRequestFn = <T>(action: ClientAction, payload: unknown) =>
		new Promise<T>((resolvePromise, rejectPromise) => {
			const send = () => {
				const requestId = crypto.randomUUID();
				const timer = setTimeout(() => {
					this.pending.delete(requestId);
					rejectPromise(new Error(`Request '${action}' timed out`));
				}, REQUEST_TIMEOUT_MS);
				this.pending.set(requestId, {
					resolve: (payload) => resolvePromise(payload as T),
					reject: rejectPromise,
					timer,
				});
				this.socket?.send(
					JSON.stringify({
						version: WS_PROTOCOL_VERSION,
						kind: "request",
						requestId,
						action,
						payload,
					}),
				);
			};
			if (this.isOpen) {
				send();
			} else {
				this.queue.push(send);
			}
		});

	private open(): void {
		const protocol = location.protocol === "https:" ? "wss" : "ws";
		const suffix =
			this.workspaceId !== null
				? `?workspace=${encodeURIComponent(this.workspaceId)}`
				: "";
		const socket = new WebSocket(`${protocol}://${location.host}/ws${suffix}`);
		this.socket = socket;

		socket.onopen = () => {
			for (const send of this.queue.splice(0)) {
				send();
			}
			for (const listener of this.openListeners) {
				listener();
			}
		};

		socket.onmessage = (event) => {
			let raw: unknown;
			try {
				raw = JSON.parse(String(event.data));
			} catch {
				return;
			}
			if (
				typeof raw === "object" &&
				raw !== null &&
				"kind" in raw &&
				raw.kind === "event"
			) {
				const parsedEvent = serverEventSchema.safeParse(raw);
				if (parsedEvent.success) {
					for (const listener of this.eventListeners) {
						listener(parsedEvent.data as ServerEvent);
					}
				}
				return;
			}
			const parsed = serverResponseSchema.safeParse(raw);
			if (!parsed.success || parsed.data.kind !== "response") {
				return;
			}
			const response = parsed.data;
			const entry = this.pending.get(response.requestId);
			if (entry === undefined) {
				return;
			}
			this.pending.delete(response.requestId);
			clearTimeout(entry.timer);
			if (response.ok) {
				entry.resolve(response.payload);
			} else {
				entry.reject(
					new WsError(
						response.error?.code ?? "INTERNAL",
						response.error?.message ?? "Request failed",
						response.error?.details,
					),
				);
			}
		};

		socket.onclose = () => {
			for (const [requestId, entry] of this.pending) {
				clearTimeout(entry.timer);
				entry.reject(new Error("WebSocket closed"));
				this.pending.delete(requestId);
			}
			if (this.started) {
				setTimeout(() => this.open(), RECONNECT_DELAY_MS);
			}
		};

		socket.onerror = () => {
			socket.close();
		};
	}
}

export const wsClient = new WsClient();
