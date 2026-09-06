import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { SQL } from "bun";
import type { ResolvedConnection, TableLimits } from "../types";
import { PostgresAdapter } from "./adapter";

/**
 * Integration test for the object view against a real PostgreSQL
 * instance (CI service or the local compose container). Creates and
 * destroys a scratch database; every test is skipped when no server is
 * reachable.
 */

const ADMIN_URL =
	Bun.env.TARGET_TEST_ADMIN_URL ??
	"postgres://datagripe:datagripe@localhost:5432/postgres";
const SCRATCH_DB = "datagripe_objectview_test";

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
		CREATE SCHEMA IF NOT EXISTS shop;
		DROP TABLE IF EXISTS shop.order_lines CASCADE;
		DROP TABLE IF EXISTS shop.orders CASCADE;
		CREATE TABLE shop.orders (
			id integer GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
			reference text NOT NULL UNIQUE,
			amount numeric(10, 2) NOT NULL DEFAULT 0,
			status text,
			note text,
			CONSTRAINT orders_amount_positive CHECK (amount >= 0)
		);
		COMMENT ON COLUMN shop.orders.reference IS 'External order reference';
		CREATE INDEX orders_status_idx ON shop.orders (status DESC);
		CREATE INDEX orders_open_idx ON shop.orders (id) WHERE status = 'open';

		CREATE TABLE shop.order_lines (
			id integer PRIMARY KEY,
			order_id integer NOT NULL REFERENCES shop.orders (id)
		);

		CREATE OR REPLACE VIEW shop.open_orders AS
			SELECT id, reference FROM shop.orders WHERE status = 'open';

		CREATE OR REPLACE FUNCTION shop.touch_order() RETURNS trigger
			LANGUAGE plpgsql AS $$ BEGIN RETURN NEW; END $$;
		DROP TRIGGER IF EXISTS orders_touch ON shop.orders;
		CREATE TRIGGER orders_touch BEFORE INSERT OR UPDATE ON shop.orders
			FOR EACH ROW EXECUTE FUNCTION shop.touch_order();

		TRUNCATE shop.order_lines;
		DELETE FROM shop.orders;
		INSERT INTO shop.orders (reference, amount, status)
			VALUES ('A-1', 10.00, 'open'), ('A-2', 20.00, 'closed');
		ANALYZE shop.orders;
	`);
});

afterAll(async () => {
	await adapter.close();
	await fixtures?.close();
	await admin?.close();
});

const table = { schema: "shop", name: "orders", kind: "table" as const };

describe("postgres object view", () => {
	pgTest("columns carry types, defaults, keys and comments", async () => {
		const result = await adapter.describeObject(CONNECTION, table, LIMITS);
		expect(result.columns.map((column) => column.name)).toEqual([
			"id",
			"reference",
			"amount",
			"status",
			"note",
		]);
		const byName = new Map(
			result.columns.map((column) => [column.name, column]),
		);
		expect(byName.get("id")?.primaryKey).toBe(true);
		expect(byName.get("id")?.nullable).toBe(false);
		expect(byName.get("amount")?.dataType).toBe("numeric(10,2)");
		expect(byName.get("amount")?.defaultExpr).toBe("0");
		expect(byName.get("reference")?.comment).toBe("External order reference");
		expect(byName.get("note")?.comment).toBeNull();
		expect(byName.get("note")?.defaultExpr).toBeNull();
	});

	pgTest(
		"indexes report method, key columns, uniqueness and size",
		async () => {
			const result = await adapter.describeObject(CONNECTION, table, LIMITS);
			const names = result.indexes.map((index) => index.name);
			expect(names).toContain("orders_pkey");
			expect(names).toContain("orders_status_idx");
			// The primary key sorts first so it reads as the anchor.
			expect(result.indexes[0]?.primary).toBe(true);

			const status = result.indexes.find(
				(index) => index.name === "orders_status_idx",
			);
			expect(status?.method).toBe("btree");
			expect(status?.columns).toBe("status DESC");
			expect(status?.unique).toBe(false);
			expect(status?.sizeBytes).toBeGreaterThanOrEqual(0);
		},
	);

	pgTest("a partial index reports only its key columns", async () => {
		// The WHERE clause has its own parentheses; a regex over the whole
		// definition would swallow it into the column list.
		const result = await adapter.describeObject(CONNECTION, table, LIMITS);
		const partial = result.indexes.find(
			(index) => index.name === "orders_open_idx",
		);
		expect(partial?.columns).toBe("id");
	});

	pgTest("constraints cover key, unique and check", async () => {
		const result = await adapter.describeObject(CONNECTION, table, LIMITS);
		const byType = new Map(
			result.constraints.map((constraint) => [
				constraint.type,
				constraint.definition,
			]),
		);
		expect(byType.get("primary key")).toBe("PRIMARY KEY (id)");
		expect(byType.get("unique")).toBe("UNIQUE (reference)");
		expect(byType.get("check")).toContain("amount >= ");
		// Primary key first, then unique, then the rest.
		expect(result.constraints[0]?.type).toBe("primary key");
	});

	pgTest("triggers report timing and every event they cover", async () => {
		const result = await adapter.describeObject(CONNECTION, table, LIMITS);
		const trigger = result.triggers.find(
			(entry) => entry.name === "orders_touch",
		);
		expect(trigger?.timing).toBe("before");
		expect(trigger?.events).toBe("insert, update");
		expect(trigger?.action).toBe("touch_order()");
		expect(trigger?.enabled).toBe(true);
	});

	pgTest("grants list the roles that hold privileges", async () => {
		const result = await adapter.describeObject(CONNECTION, table, LIMITS);
		const owner = result.grants.find((grant) => grant.grantee === "datagripe");
		expect(owner?.privileges).toContain("select");
		expect(owner?.grantor).toBe("datagripe");
	});

	pgTest("statistics report rows and sizes as formatted tiles", async () => {
		const result = await adapter.describeObject(CONNECTION, table, LIMITS);
		const labels = result.statistics.map((stat) => stat.label);
		expect(labels).toContain("rows (estimated)");
		expect(labels).toContain("heap");
		expect(labels).toContain("indexes");
		expect(
			result.statistics.find((stat) => stat.label === "rows (estimated)")
				?.value,
		).toBe("2");
		expect(result.rowEstimate).toBe(2);
		// Neither postgres source is exact, so the header always says so.
		expect(result.estimated).toBe(true);
	});

	pgTest("table DDL is reconstructed and flagged as such", async () => {
		const result = await adapter.describeObject(CONNECTION, table, LIMITS);
		expect(result.ddlReconstructed).toBe(true);
		expect(result.ddl).toContain('create table "shop"."orders"');
		// Column names are padded so the types line up, as in the mock.
		expect(result.ddl).toContain("numeric(10,2) not null default 0");
		expect(result.ddl).toContain(
			"integer not null generated always as identity",
		);
		expect(result.ddl).toContain('constraint "orders_pkey" PRIMARY KEY (id)');
		// Secondary indexes follow as their own statements; the primary key
		// is already in the table body and must not be repeated.
		expect(result.ddl).toContain("CREATE INDEX orders_status_idx");
		// Constraint-backed indexes are emitted by their constraint, so
		// repeating them would create the same index twice.
		expect(result.ddl).not.toContain("CREATE UNIQUE INDEX orders_pkey");
		expect(result.ddl).not.toContain(
			"CREATE UNIQUE INDEX orders_reference_key",
		);
	});

	pgTest("view DDL is the server's own definition", async () => {
		const result = await adapter.describeObject(
			CONNECTION,
			{ schema: "shop", name: "open_orders", kind: "view" },
			LIMITS,
		);
		expect(result.ddlReconstructed).toBe(false);
		expect(result.ddl).toContain('create or replace view "shop"."open_orders"');
		expect(result.ddl).toContain("WHERE");
		expect(result.columns.map((column) => column.name)).toEqual([
			"id",
			"reference",
		]);
	});

	pgTest("dependents name what a drop would take with it", async () => {
		const result = await adapter.describeObject(CONNECTION, table, LIMITS);
		const names = result.dependents.map((dependent) => dependent.name);
		expect(names.some((name) => name.includes("open_orders"))).toBe(true);
		expect(names.some((name) => name.includes("order_lines"))).toBe(true);
		const kinds = new Set(result.dependents.map((entry) => entry.kind));
		expect(kinds.has("view")).toBe(true);
		expect(kinds.has("foreign key")).toBe(true);
	});

	pgTest("every tab is answerable on postgres", async () => {
		const result = await adapter.describeObject(CONNECTION, table, LIMITS);
		expect(result.unsupported).toEqual([]);
	});

	pgTest(
		"a missing relation is a request error, not an empty view",
		async () => {
			await expect(
				adapter.describeObject(
					CONNECTION,
					{ schema: "shop", name: "no_such_table", kind: "table" },
					LIMITS,
				),
			).rejects.toThrow(/was not found/);
		},
	);

	pgTest("describing an object cannot write", async () => {
		// The whole describe runs in a READ ONLY transaction; nothing in it
		// should be able to leave a trace even if a catalog function tried.
		const before = await fixtures`SELECT count(*) AS n FROM shop.orders`;
		await adapter.describeObject(CONNECTION, table, LIMITS);
		const after = await fixtures`SELECT count(*) AS n FROM shop.orders`;
		expect(Number(after[0]?.n)).toBe(Number(before[0]?.n));
	});
});
