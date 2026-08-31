/**
 * Load test driver (docs/operations.md): exercises a running server
 * through the real protocol — login, workspace.open, schema.children,
 * execution.start — at a chosen concurrency and prints latency
 * percentiles and throughput.
 *
 * Usage:
 *   bun scripts/load-test.ts --url http://localhost:3001 \
 *     --email you@example.com --password '…' \
 *     --concurrency 10 --requests 200 [--mode mixed|execute]
 */

import { WS_PROTOCOL_VERSION } from "../packages/contracts/src/ws";

interface Args {
	url: string;
	email: string;
	password: string;
	concurrency: number;
	requests: number;
	mode: "mixed" | "execute";
}

function parseArgs(): Args {
	const args = Bun.argv.slice(2);
	const get = (name: string, fallback: string) => {
		const index = args.indexOf(`--${name}`);
		return index !== -1 && args[index + 1] !== undefined
			? (args[index + 1] as string)
			: fallback;
	};
	return {
		url: get("url", "http://localhost:3001"),
		email: get("email", ""),
		password: get("password", ""),
		concurrency: Number(get("concurrency", "10")),
		requests: Number(get("requests", "200")),
		mode: get("mode", "mixed") as Args["mode"],
	};
}

class TestWsClient {
	private socket: WebSocket | null = null;
	private readonly pending = new Map<
		string,
		{ resolve: (v: unknown) => void; reject: (e: Error) => void }
	>();
	private readonly eventWaiters = new Map<
		string,
		(event: { topic: string }) => void
	>();

	async connect(wsUrl: string, cookie: string, origin: string): Promise<void> {
		const { promise, resolve, reject } = Promise.withResolvers<void>();
		this.socket = new WebSocket(wsUrl, {
			headers: { cookie, origin },
		} as never);
		this.socket.onopen = () => resolve();
		this.socket.onerror = () => reject(new Error("ws connect failed"));
		this.socket.onmessage = (event) => {
			const message = JSON.parse(String(event.data)) as {
				kind: string;
				requestId?: string;
				ok?: boolean;
				payload?: unknown;
				error?: { message?: string };
				executionId?: string;
				topic?: string;
			};
			if (message.kind === "event") {
				if (message.executionId !== undefined) {
					const waiter = this.eventWaiters.get(message.executionId);
					if (waiter !== undefined && message.topic !== undefined) {
						waiter({ topic: message.topic });
					}
				}
				return;
			}
			if (message.kind !== "response" || message.requestId === undefined) {
				return;
			}
			const entry = this.pending.get(message.requestId);
			if (entry === undefined) {
				return;
			}
			this.pending.delete(message.requestId);
			if (message.ok === true) {
				entry.resolve(message.payload);
			} else {
				entry.reject(new Error(message.error?.message ?? "failed"));
			}
		};
		return promise;
	}

	request(action: string, payload: unknown): Promise<unknown> {
		const requestId = crypto.randomUUID();
		const { promise, resolve, reject } = Promise.withResolvers<unknown>();
		this.pending.set(requestId, { resolve, reject });
		this.socket?.send(
			JSON.stringify({
				version: WS_PROTOCOL_VERSION,
				kind: "request",
				requestId,
				action,
				payload,
			}),
		);
		return promise;
	}

	/** Resolve when an execution reaches a terminal event. Registers the
	 * waiter first, then replays via execution.subscribe so events that
	 * fired in between are not missed. */
	async waitTerminal(executionId: string): Promise<string> {
		const TERMINAL = new Set([
			"execution.completed",
			"execution.failed",
			"execution.cancelled",
		]);
		const { promise, resolve } = Promise.withResolvers<string>();
		const waiter = (event: { topic: string }) => {
			if (TERMINAL.has(event.topic)) {
				this.eventWaiters.delete(executionId);
				resolve(event.topic);
			}
		};
		this.eventWaiters.set(executionId, waiter);
		const replay = (await this.request("execution.subscribe", {
			executionId,
			afterSequence: 0,
		})) as { events: Array<{ topic: string }> };
		for (const event of replay.events) {
			waiter(event);
		}
		return promise;
	}

	close(): void {
		this.socket?.close();
	}
}

function percentile(sorted: number[], p: number): number {
	const index = Math.min(
		sorted.length - 1,
		Math.floor((p / 100) * sorted.length),
	);
	return sorted[index] ?? 0;
}

async function main(): Promise<void> {
	const args = parseArgs();
	if (args.email === "" || args.password === "") {
		console.error("--email and --password are required");
		process.exit(1);
	}

	const login = await fetch(`${args.url}/api/auth/login`, {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify({ email: args.email, password: args.password }),
	});
	if (!login.ok) {
		console.error(`login failed: ${login.status}`);
		process.exit(1);
	}
	const cookie = (login.headers.get("set-cookie") ?? "").split(";")[0] ?? "";

	const ws = new TestWsClient();
	const wsUrl = `${args.url.replace(/^http/, "ws")}/ws`;
	await ws.connect(wsUrl, cookie, args.url);

	const opened = (await ws.request("workspace.open", {})) as {
		connections: Array<{ id: string }>;
	};
	const connectionId = opened.connections[0]?.id;
	if (connectionId === undefined) {
		console.error("no connection available in workspace");
		process.exit(1);
	}

	const tasks: Array<() => Promise<unknown>> = [];
	for (let i = 0; i < args.requests; i++) {
		if (args.mode === "execute" || i % 2 === 0) {
			tasks.push(async () => {
				const result = (await ws.request("execution.start", {
					connectionId,
					sql: "select 1",
					idempotencyKey: crypto.randomUUID(),
				})) as { executionId: string };
				await ws.waitTerminal(result.executionId);
			});
		} else {
			tasks.push(() =>
				ws.request("schema.children", {
					connectionId,
					path: [],
					refresh: false,
				}),
			);
		}
	}

	const latencies: number[] = [];
	let failed = 0;
	let firstError = "";
	let cursor = 0;
	const started = performance.now();
	async function worker(): Promise<void> {
		while (cursor < tasks.length) {
			const task = tasks[cursor++];
			if (task === undefined) {
				return;
			}
			const t0 = performance.now();
			try {
				await task();
				latencies.push(performance.now() - t0);
			} catch (error) {
				failed++;
				if (firstError === "") {
					firstError = error instanceof Error ? error.message : String(error);
				}
			}
		}
	}
	await Promise.all(Array.from({ length: args.concurrency }, () => worker()));
	const elapsedSeconds = (performance.now() - started) / 1000;

	latencies.sort((a, b) => a - b);
	console.log(
		JSON.stringify(
			{
				requests: tasks.length,
				failed,
				...(firstError !== "" ? { firstError } : {}),
				concurrency: args.concurrency,
				throughputPerSecond: Math.round(tasks.length / elapsedSeconds),
				p50ms: Math.round(percentile(latencies, 50)),
				p95ms: Math.round(percentile(latencies, 95)),
				p99ms: Math.round(percentile(latencies, 99)),
			},
			null,
			2,
		),
	);
	ws.close();
	process.exit(0);
}

await main();
