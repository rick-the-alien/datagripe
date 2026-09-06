import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { SQL } from "bun";
import type { ResolvedConnection, TableLimits } from "../types";
import { PostgresAdapter } from "./adapter";

/**
 * Integration test for the table view against a real PostgreSQL
 * instance (CI service or the local compose container). Creates and
 * destroys a scratch database; every test is skipped when no server is
 * reachable.
 */

const ADMIN_URL =
	Bun.env.TARGET_TEST_ADMIN_URL ??
	"postgres://datagripe:datagripe@localhost:5432/postgres";
const SCRATCH_DB = "datagripe_tabledata_test";

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
	readOnly: false,
};

const LIMITS: TableLimits = {
	timeoutMs: 10_000,
	maxRows: 500,
	estimateAboveRows: 100_000,
};

const adapter = new PostgresAdapter();
let admin: SQL;
let fixtures: SQL;

/** Every test starts from the same three rows. */
async function reseed(): Promise<void> {
	await fixtures.unsafe(`
		TRUNCATE app.payments;
		INSERT INTO app.payments (id, amount, note, meta) VALUES
			(1, 10.00, 'first',  '{"a": 1}'),
			(2, 20.00, NULL,     NULL),
			(3, 30.00, 'third',  '{"b": [1, 2]}');
	`);
}

beforeAll(async () => {
	if (!reachable) {
		return;
	}
	admin = new SQL(ADMIN_URL);
	const existing =
		await admin`SELECT 1 FROM pg_database WHERE datname = ${SCRATCH_DB}`;
	if (existing.length === 0) {
		await admin.unsafe(`CREATE DATABASE ${SCRATCH_DB}`);
	}
	fixtures = new SQL(
		`postgres://datagripe:datagripe@localhost:5432/${SCRATCH_DB}`,
	);
	await fixtures.unsafe(`
		CREATE SCHEMA IF NOT EXISTS app;
		DROP TABLE IF EXISTS app.payments CASCADE;
		DROP TABLE IF EXISTS app.keyless CASCADE;
		CREATE TABLE app.payments (
			id integer PRIMARY KEY,
			amount numeric(10, 2) NOT NULL,
			note text,
			meta jsonb,
			doubled numeric GENERATED ALWAYS AS (amount * 2) STORED
		);
		CREATE TABLE app.keyless (label text);
		CREATE OR REPLACE VIEW app.payment_notes AS
			SELECT id, note FROM app.payments;
		CREATE OR REPLACE FUNCTION app.sneak() RETURNS text
			LANGUAGE sql VOLATILE AS
		$$ INSERT INTO app.keyless VALUES ('sneaked') RETURNING label $$;
	`);
	await reseed();
});

afterAll(async () => {
	await adapter.close();
	await fixtures?.close();
	await admin?.close();
});

function request(overrides: Record<string, unknown> = {}) {
	return {
		schema: "app",
		table: "payments",
		kind: "table" as const,
		limit: 100,
		offset: 0,
		sort: [],
		filter: "",
		count: true,
		...overrides,
	};
}

describe("postgres table view", () => {
	pgTest("reads columns with key, generated and default flags", async () => {
		const result = await adapter.readTable(CONNECTION, request(), LIMITS);
		expect(result.columns.map((column) => column.name)).toEqual([
			"id",
			"amount",
			"note",
			"meta",
			"doubled",
		]);
		const byName = new Map(
			result.columns.map((column) => [column.name, column]),
		);
		expect(byName.get("id")?.primaryKey).toBe(true);
		expect(byName.get("id")?.nullable).toBe(false);
		expect(byName.get("amount")?.dataType).toBe("numeric(10,2)");
		expect(byName.get("note")?.nullable).toBe(true);
		expect(byName.get("doubled")?.generated).toBe(true);
		expect(result.editable).toBe(true);
	});

	pgTest("reads a page with an exact count", async () => {
		await reseed();
		const result = await adapter.readTable(
			CONNECTION,
			request({ sort: [{ column: "id", direction: "asc" }] }),
			LIMITS,
		);
		expect(result.totalRows).toBe(3);
		expect(result.estimated).toBe(false);
		expect(result.rows).toHaveLength(3);
		expect(result.rows[0]?.[0]).toBe(1);
		expect(result.rows[1]?.[2]).toBeNull();
	});

	pgTest("sorts, filters and pages server-side", async () => {
		await reseed();
		const sorted = await adapter.readTable(
			CONNECTION,
			request({ sort: [{ column: "amount", direction: "desc" }] }),
			LIMITS,
		);
		expect(sorted.rows.map((row) => row[0])).toEqual([3, 2, 1]);

		const filtered = await adapter.readTable(
			CONNECTION,
			request({ filter: "amount > 15" }),
			LIMITS,
		);
		expect(filtered.totalRows).toBe(2);

		const paged = await adapter.readTable(
			CONNECTION,
			request({
				sort: [{ column: "id", direction: "asc" }],
				limit: 1,
				offset: 2,
			}),
			LIMITS,
		);
		expect(paged.rows.map((row) => row[0])).toEqual([3]);
		expect(paged.totalRows).toBe(3);
	});

	pgTest("a view is browsable but not editable", async () => {
		const result = await adapter.readTable(
			CONNECTION,
			request({ table: "payment_notes", kind: "view" }),
			LIMITS,
		);
		expect(result.rows.length).toBeGreaterThan(0);
		expect(result.editable).toBe(false);
		expect(result.reason).toMatch(/Views/);
	});

	pgTest(
		"a table with no primary key is browsable but not editable",
		async () => {
			const result = await adapter.readTable(
				CONNECTION,
				request({ table: "keyless" }),
				LIMITS,
			);
			expect(result.editable).toBe(false);
			expect(result.reason).toMatch(/primary key/);
		},
	);

	pgTest("a read-only connection cannot be edited", async () => {
		const result = await adapter.readTable(
			{ ...CONNECTION, readOnly: true },
			request(),
			LIMITS,
		);
		expect(result.editable).toBe(false);
		expect(result.reason).toMatch(/read-only/);
	});

	pgTest(
		"a stacked filter is rejected before it reaches the server",
		async () => {
			await expect(
				adapter.readTable(
					CONNECTION,
					request({ filter: "1=1; DROP TABLE app.payments" }),
					LIMITS,
				),
			).rejects.toThrow(/single expression/);
			// The table is still there.
			const rows = await fixtures`SELECT count(*) AS n FROM app.payments`;
			expect(Number(rows[0]?.n)).toBe(3);
		},
	);

	pgTest("a subquery in the filter is allowed", async () => {
		await reseed();
		const result = await adapter.readTable(
			CONNECTION,
			request({
				filter: "id IN (SELECT id FROM app.payments WHERE amount > 15)",
			}),
			LIMITS,
		);
		expect(result.totalRows).toBe(2);
	});

	pgTest("the read path cannot write, whatever the filter calls", async () => {
		// The READ ONLY transaction is what makes the raw filter box safe:
		// a function that writes fails on the write, not on parsing.
		await reseed();
		await expect(
			adapter.readTable(
				CONNECTION,
				request({ filter: "app.sneak() IS NOT NULL" }),
				LIMITS,
			),
		).rejects.toThrow(/read-only transaction/);
		const rows = await fixtures`SELECT count(*) AS n FROM app.keyless`;
		expect(Number(rows[0]?.n)).toBe(0);
	});

	pgTest("updates, inserts and deletes one row each", async () => {
		await reseed();
		const outcome = await adapter.mutateTable(
			CONNECTION,
			{
				schema: "app",
				table: "payments",
				edits: [
					{
						type: "update",
						key: { id: { kind: "text", text: "1" } },
						values: {
							amount: { kind: "text", text: "11.50" },
							note: { kind: "null" },
						},
					},
					{
						type: "insert",
						values: {
							id: { kind: "text", text: "4" },
							amount: { kind: "text", text: "40.00" },
							note: { kind: "text", text: "fourth" },
							meta: { kind: "default" },
						},
					},
					{ type: "delete", key: { id: { kind: "text", text: "2" } } },
				],
			},
			LIMITS,
		);
		expect(outcome.applied).toBe(3);

		const rows =
			await fixtures`SELECT id, amount, note, doubled FROM app.payments ORDER BY id`;
		expect(rows.map((row: { id: number }) => row.id)).toEqual([1, 3, 4]);
		expect(Number(rows[0]?.amount)).toBe(11.5);
		expect(rows[0]?.note).toBeNull();
		// The generated column followed the update rather than being written.
		expect(Number(rows[0]?.doubled)).toBe(23);
	});

	pgTest("a whole batch rolls back when one edit misses", async () => {
		await reseed();
		await expect(
			adapter.mutateTable(
				CONNECTION,
				{
					schema: "app",
					table: "payments",
					edits: [
						{
							type: "update",
							key: { id: { kind: "text", text: "1" } },
							values: { note: { kind: "text", text: "changed" } },
						},
						// No row 999 — the batch must not half-apply.
						{
							type: "update",
							key: { id: { kind: "text", text: "999" } },
							values: { note: { kind: "text", text: "ghost" } },
						},
					],
				},
				LIMITS,
			),
		).rejects.toThrow(/matched 0 rows/);

		const rows = await fixtures`SELECT note FROM app.payments WHERE id = 1`;
		expect(rows[0]?.note).toBe("first");
	});

	pgTest("a generated column cannot be written", async () => {
		await expect(
			adapter.mutateTable(
				CONNECTION,
				{
					schema: "app",
					table: "payments",
					edits: [
						{
							type: "update",
							key: { id: { kind: "text", text: "1" } },
							values: { doubled: { kind: "text", text: "1" } },
						},
					],
				},
				LIMITS,
			),
		).rejects.toThrow(/generated/);
	});

	pgTest("a read-only connection refuses to mutate", async () => {
		await expect(
			adapter.mutateTable(
				{ ...CONNECTION, readOnly: true },
				{
					schema: "app",
					table: "payments",
					edits: [{ type: "delete", key: { id: { kind: "text", text: "1" } } }],
				},
				LIMITS,
			),
		).rejects.toThrow(/read-only/);
	});
});
