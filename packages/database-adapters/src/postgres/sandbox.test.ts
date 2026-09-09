import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { SQL } from "bun";
import type { ResolvedConnection } from "../types";
import { PostgresAdapter } from "./adapter";

/**
 * Layer 2 of read-only MCP mode, against a real server
 * (docs/spec/mcp.md "Read-only").
 *
 * Layer 1 — statement classification — is what refuses a write, and it
 * is tested in `apps/server/src/mcp/readonly.test.ts`. This file exists
 * because a rollback that is assumed rather than proven is not a layer
 * at all: it runs the writes *past* the classifier, straight at the
 * adapter, and checks that nothing survived.
 */

const ADMIN_URL =
	Bun.env.TARGET_TEST_ADMIN_URL ??
	"postgres://datagripe:datagripe@localhost:5432/postgres";
const SCRATCH_DB = "datagripe_sandbox_test";

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

const CONNECTION: ResolvedConnection = {
	adapter: "postgres",
	host: "localhost",
	port: 5432,
	database: SCRATCH_DB,
	username: "datagripe",
	password: "datagripe",
	tlsMode: "disable",
	// Deliberately *not* a read-only connection: layer 3 would otherwise
	// be doing the work and layer 2 would go untested.
	readOnly: false,
};

const LIMITS = {
	timeoutMs: 10_000,
	maxRows: 100,
	maxBytes: 1_000_000,
	batchRows: 50,
	readOnly: false,
	sandbox: true,
};

const adapter = new PostgresAdapter();
let fixtures: SQL;

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
	fixtures = new SQL(
		`postgres://datagripe:datagripe@localhost:5432/${SCRATCH_DB}`,
	);
	await fixtures.unsafe(`
		DROP TABLE IF EXISTS sandbox_rows;
		CREATE TABLE sandbox_rows (id integer PRIMARY KEY, note text);
		INSERT INTO sandbox_rows VALUES (1, 'original');
	`);
});

afterAll(async () => {
	await fixtures?.close();
	await adapter.close();
});

async function run(statements: string[]) {
	const session = await adapter.beginExecution(CONNECTION, LIMITS);
	const collected: unknown[][] = [];
	try {
		return {
			result: await session.run(
				statements,
				{
					columns: () => {},
					rows: (_set, rows) => collected.push(...rows),
					statementDone: () => {},
				},
				() => false,
			),
			rows: collected,
		};
	} finally {
		await session.close();
	}
}

describe("sandbox sessions", () => {
	pgTest("reads work exactly as they do outside one", async () => {
		const { result, rows } = await run(["select note from sandbox_rows"]);
		expect(result.outcome).toBe("completed");
		expect(rows).toEqual([["original"]]);
	});

	pgTest("a write is refused by the transaction itself", async () => {
		const { result } = await run([
			"insert into sandbox_rows values (2, 'snuck in')",
		]);
		expect(result.outcome).toBe("failed");
		expect(result.error?.message).toContain("read-only transaction");
		const rows = await fixtures`SELECT count(*)::int AS n FROM sandbox_rows`;
		expect(rows[0]?.n).toBe(1);
	});

	pgTest("nothing a whole run did survives it", async () => {
		// Two statements, the first of which would be legal in a writable
		// transaction: the rollback has to take it with it.
		const { result } = await run([
			"create temporary table t_sandbox (a int)",
			"update sandbox_rows set note = 'changed'",
		]);
		expect(result.outcome).toBe("failed");
		const rows = await fixtures`SELECT note FROM sandbox_rows WHERE id = 1`;
		expect(rows[0]?.note).toBe("original");
	});

	pgTest("a failed statement does not poison the ones after it", async () => {
		// A syntax error inside a sandbox aborts the transaction; the
		// cursor path's savepoint is what lets the session report the
		// real error instead of "current transaction is aborted".
		const { result } = await run(["select * from no_such_table"]);
		expect(result.outcome).toBe("failed");
		expect(result.error?.message).toContain("no_such_table");
	});

	pgTest("the connection is usable again afterwards", async () => {
		await run(["insert into sandbox_rows values (3, 'no')"]).catch(() => {});
		// Same pool, next session: the ROLLBACK in close() has to have
		// left the reserved connection clean.
		const { result, rows } = await run([
			"select count(*)::int as n from sandbox_rows",
		]);
		expect(result.outcome).toBe("completed");
		expect(rows).toEqual([[1]]);
	});
});
