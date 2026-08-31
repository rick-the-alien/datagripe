import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import type { ExecutionStartRequest } from "@datagripe/contracts";
import {
	PostgresAdapter,
	type ResolvedConnection,
} from "@datagripe/database-adapters";
import { SQL } from "bun";
import { ensureLocalWorkspace } from "../bootstrap";
import { migrate } from "../db/app/migrate";
import type { AppDb } from "../db/app/pool";
import { createExecutionRegistry, type ExecutionRegistry } from "./registry";

/**
 * Execution registry integration test against real PostgreSQL (app DB for
 * history, demo target for queries). Skipped when unreachable.
 */

const ADMIN_URL = "postgres://datagripe:datagripe@localhost:5432/postgres";
const SCRATCH_DB = "datagripe_execution_test";

async function probe(): Promise<boolean> {
	try {
		const sql = new SQL(ADMIN_URL, { connectionTimeout: 2 });
		await sql`SELECT 1`;
		await sql.close();
		return true;
	} catch {
		return false;
	}
}

const reachable = await probe();
const pgTest = reachable ? test : test.skip;

const TARGET: ResolvedConnection & { source: "managed" | "predefined" } = {
	adapter: "postgres",
	host: "localhost",
	port: 5432,
	database: "demo",
	username: "datagripe",
	password: "datagripe",
	tlsMode: "disable",
	readOnly: false,
	source: "predefined",
};

let appDb: AppDb;
let registry: ExecutionRegistry;
const adapter = new PostgresAdapter();
let events: Array<{
	executionId: string;
	topic: string;
	sequence: number;
	payload: unknown;
}>;
let USER_ID = "";
const WORKSPACE = { id: "00000000-0000-4000-8000-0000000000ff", name: "Local" };

const LIMITS = {
	timeoutMs: 1_000,
	maxRows: 10_000,
	maxBytes: 25_000_000,
	maxConcurrentPerUser: 2,
};

beforeAll(async () => {
	if (!reachable) {
		return;
	}
	const admin = new SQL(ADMIN_URL);
	const existing =
		await admin`SELECT 1 FROM pg_database WHERE datname = ${SCRATCH_DB}`;
	if (existing.length === 0) {
		await admin.unsafe(`CREATE DATABASE ${SCRATCH_DB}`);
	}
	await admin.close();
	appDb = new SQL(
		`postgres://datagripe:datagripe@localhost:5432/${SCRATCH_DB}`,
	);
	await migrate(appDb);
	await appDb.unsafe("TRUNCATE query_executions, idempotency_keys CASCADE");
	USER_ID = (await ensureLocalWorkspace(appDb)).user.id;

	events = [];
	registry = createExecutionRegistry({
		adapters: {
			postgres: adapter,
			mysql: adapter,
			sqlite: adapter,
			redis: adapter,
		} as never,
		appDb,
		limits: LIMITS,
		resolveConnection: async () => TARGET,
		emit: (_userId, executionId, topic, sequence, payload) => {
			events.push({ executionId, topic, sequence, payload });
		},
	});
});

afterAll(async () => {
	await adapter.close();
	await appDb?.close();
});

function request(sql: string): ExecutionStartRequest {
	return {
		connectionId: "local-demo",
		sql,
		idempotencyKey: crypto.randomUUID(),
	};
}

function eventsFor(executionId: string) {
	return events.filter((event) => event.executionId === executionId);
}

async function waitForTerminal(
	source: ExecutionRegistry,
	executionId: string,
): Promise<string> {
	for (let i = 0; i < 100; i++) {
		const status = source.get(executionId)?.status;
		if (
			status === "succeeded" ||
			status === "failed" ||
			status === "cancelled"
		) {
			return status;
		}
		await new Promise((resolve) => setTimeout(resolve, 25));
	}
	throw new Error(`execution ${executionId} never reached a terminal state`);
}

describe("execution registry", () => {
	pgTest("SELECT streams columns and rows, then completes", async () => {
		const { executionId } = await registry.start(
			USER_ID,
			WORKSPACE,
			request("select id, sku, title from shop.products order by id"),
		);
		expect(await waitForTerminal(registry, executionId)).toBe("succeeded");

		const topics = eventsFor(executionId).map((event) => event.topic);
		expect(topics[0]).toBe("execution.started");
		expect(topics).toContain("execution.columns");
		expect(topics).toContain("execution.rows");
		expect(topics).toContain("execution.progress");
		expect(topics.at(-1)).toBe("execution.completed");

		const columns = eventsFor(executionId).find(
			(event) => event.topic === "execution.columns",
		)?.payload as { columns: Array<{ name: string }> };
		expect(columns.columns.map((c) => c.name)).toEqual(["id", "sku", "title"]);

		const rowEvents = eventsFor(executionId).filter(
			(event) => event.topic === "execution.rows",
		);
		const allRows = rowEvents.flatMap(
			(event) => (event.payload as { rows: unknown[][] }).rows,
		);
		expect(allRows.length).toBe(2);
		expect(allRows[0]).toContain("SKU-1");

		const history = await appDb`
			SELECT status, row_count, truncated FROM query_executions WHERE id = ${executionId}
		`;
		expect(history[0]).toMatchObject({ status: "succeeded", truncated: false });
	});

	pgTest(
		"multi-statement document runs sequentially with progress",
		async () => {
			const { executionId } = await registry.start(
				USER_ID,
				WORKSPACE,
				request(
					"create temp table multi_t (id int); insert into multi_t values (1),(2); select count(*) as n from multi_t",
				),
			);
			expect(await waitForTerminal(registry, executionId)).toBe("succeeded");
			const progress = eventsFor(executionId)
				.filter((event) => event.topic === "execution.progress")
				.map(
					(event) =>
						event.payload as { command: string; affectedRows?: number },
				);
			expect(progress.map((p) => p.command)).toEqual([
				"CREATE TABLE",
				"INSERT",
				"SELECT",
			]);
			expect(progress[1]?.affectedRows).toBe(2);
		},
	);

	pgTest("row cap truncates and marks the history row", async () => {
		const small = createExecutionRegistry({
			adapters: {
				postgres: adapter,
				mysql: adapter,
				sqlite: adapter,
				redis: adapter,
			} as never,
			appDb,
			limits: { ...LIMITS, maxRows: 5 },
			resolveConnection: async () => TARGET,
			emit: (_userId, executionId, topic, sequence, payload) => {
				events.push({ executionId, topic, sequence, payload });
			},
		});
		const { executionId } = await small.start(
			USER_ID,
			WORKSPACE,
			request("select generate_series(1, 100) AS n"),
		);
		expect(await waitForTerminal(small, executionId)).toBe("succeeded");
		const completed = eventsFor(executionId).find(
			(event) => event.topic === "execution.completed",
		)?.payload as { rowCount: number; truncated: boolean };
		expect(completed).toMatchObject({ rowCount: 5, truncated: true });
		const history = await appDb`
			SELECT truncated FROM query_executions WHERE id = ${executionId}
		`;
		expect(history[0]?.truncated).toBe(true);
	});

	pgTest("statement timeout fails with QUERY_TIMEOUT", async () => {
		const { executionId } = await registry.start(
			USER_ID,
			WORKSPACE,
			request("select pg_sleep(5)"),
		);
		expect(await waitForTerminal(registry, executionId)).toBe("failed");
		const failed = eventsFor(executionId).find(
			(event) => event.topic === "execution.failed",
		)?.payload as { code?: string; message: string };
		expect(failed.code).toBe("QUERY_TIMEOUT");
		expect(failed.message).toContain("statement timeout");
	});

	pgTest(
		"cancellation returns cancelled quickly via the control path",
		async () => {
			const { executionId } = await registry.start(
				USER_ID,
				WORKSPACE,
				request("select pg_sleep(30)"),
			);
			await new Promise((resolve) => setTimeout(resolve, 300));
			const before = Date.now();
			const ack = await registry.cancel(USER_ID, executionId);
			expect(ack.status).toBe("running");
			expect(await waitForTerminal(registry, executionId)).toBe("cancelled");
			expect(Date.now() - before).toBeLessThan(5_000);
			// Idempotent: cancelling again returns the terminal state.
			const again = await registry.cancel(USER_ID, executionId);
			expect(again.status).toBe("cancelled");
		},
	);

	pgTest("syntax error fails with the database message", async () => {
		const { executionId } = await registry.start(
			USER_ID,
			WORKSPACE,
			request("select * from no_such_table_xyz"),
		);
		expect(await waitForTerminal(registry, executionId)).toBe("failed");
		const failed = eventsFor(executionId).find(
			(event) => event.topic === "execution.failed",
		)?.payload as { message: string };
		expect(failed.message).toContain("no_such_table_xyz");
	});

	pgTest("read-only connections reject writes", async () => {
		const readOnly = { ...TARGET, readOnly: true };
		const ro = createExecutionRegistry({
			adapters: {
				postgres: adapter,
				mysql: adapter,
				sqlite: adapter,
				redis: adapter,
			} as never,
			appDb,
			limits: LIMITS,
			resolveConnection: async () => readOnly,
			emit: (_userId, executionId, topic, sequence, payload) => {
				events.push({ executionId, topic, sequence, payload });
			},
		});
		const { executionId } = await ro.start(
			USER_ID,
			WORKSPACE,
			request("create table should_not_exist (id int)"),
		);
		expect(await waitForTerminal(ro, executionId)).toBe("failed");
		const failed = eventsFor(executionId).find(
			(event) => event.topic === "execution.failed",
		)?.payload as { message: string };
		expect(failed.message.toLowerCase()).toContain("read-only");
	});

	pgTest("concurrency limit rejects excess executions", async () => {
		const first = await registry.start(
			USER_ID,
			WORKSPACE,
			request("select pg_sleep(5)"),
		);
		const second = await registry.start(
			USER_ID,
			WORKSPACE,
			request("select pg_sleep(5)"),
		);
		await expect(
			registry.start(USER_ID, WORKSPACE, request("select 1")),
		).rejects.toMatchObject({
			code: "RATE_LIMITED",
		});
		await registry.cancel(USER_ID, first.executionId);
		await registry.cancel(USER_ID, second.executionId);
		await waitForTerminal(registry, first.executionId);
		await waitForTerminal(registry, second.executionId);
	});

	pgTest("replay returns buffered events after a sequence", async () => {
		const { executionId } = await registry.start(
			USER_ID,
			WORKSPACE,
			request("select 1 AS one"),
		);
		expect(await waitForTerminal(registry, executionId)).toBe("succeeded");
		const all = registry.replay(USER_ID, executionId, 0);
		expect(all.length).toBeGreaterThanOrEqual(4);
		const tail = registry.replay(
			USER_ID,
			executionId,
			all[all.length - 2]?.sequence ?? 0,
		);
		expect(tail).toHaveLength(1);
		expect(tail[0]?.topic).toBe("execution.completed");
	});

	pgTest("start with no executable statement is rejected", async () => {
		await expect(
			registry.start(USER_ID, WORKSPACE, request("-- only a comment")),
		).rejects.toMatchObject({ code: "BAD_REQUEST" });
	});
});
