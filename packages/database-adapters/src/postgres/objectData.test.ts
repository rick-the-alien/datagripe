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

		CREATE OR REPLACE FUNCTION shop.order_total(order_id integer, vat numeric DEFAULT 0.2)
			RETURNS numeric LANGUAGE sql STABLE STRICT AS
		$$ SELECT amount * (1 + vat) FROM shop.orders WHERE id = order_id $$;
		COMMENT ON FUNCTION shop.order_total(integer, numeric) IS 'Gross order total';
		-- An overload, to prove the identity signature is what selects a row.
		CREATE OR REPLACE FUNCTION shop.order_total(reference text)
			RETURNS numeric LANGUAGE sql STABLE AS
		$$ SELECT amount FROM shop.orders WHERE reference = $1 $$;

		DROP SEQUENCE IF EXISTS shop.ticket_seq;
		CREATE SEQUENCE shop.ticket_seq AS integer
			INCREMENT BY 5 MINVALUE 10 MAXVALUE 500 START WITH 10 CACHE 2 CYCLE;
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

	pgTest("a function's ddl is its real definition, body included", async () => {
		const result = await adapter.describeObject(
			CONNECTION,
			{
				schema: "shop",
				name: "order_total(order_id integer, vat numeric)",
				kind: "function",
			},
			LIMITS,
		);
		// pg_get_functiondef is verbatim, which is the point of the tab.
		expect(result.ddlReconstructed).toBe(false);
		expect(result.ddl).toContain("CREATE OR REPLACE FUNCTION shop.order_total");
		expect(result.ddl).toContain("amount * (1 + vat)");
	});

	pgTest("a routine offers only the tabs it has", async () => {
		const result = await adapter.describeObject(
			CONNECTION,
			{
				schema: "shop",
				name: "order_total(order_id integer, vat numeric)",
				kind: "function",
			},
			LIMITS,
		);
		expect(result.tabs).toEqual(["arguments", "grants", "statistics", "ddl"]);
		// A routine has no rows, columns, indexes or triggers at all —
		// absent from `tabs`, not reported unsupported.
		expect(result.columns).toEqual([]);
		expect(result.indexes).toEqual([]);
		expect(result.rowEstimate).toBeNull();
		expect(result.unsupported).toEqual([]);
	});

	pgTest("arguments carry name, type and mode in order", async () => {
		const result = await adapter.describeObject(
			CONNECTION,
			{
				schema: "shop",
				name: "order_total(order_id integer, vat numeric)",
				kind: "function",
			},
			LIMITS,
		);
		expect(result.arguments).toEqual([
			{ name: "order_id", dataType: "integer", mode: "in" },
			{ name: "vat", dataType: "numeric", mode: "in" },
		]);
	});

	pgTest("the identity signature selects between overloads", async () => {
		const single = await adapter.describeObject(
			CONNECTION,
			{ schema: "shop", name: "order_total(reference text)", kind: "function" },
			LIMITS,
		);
		expect(single.arguments).toEqual([
			{ name: "reference", dataType: "text", mode: "in" },
		]);
		expect(single.ddl).toContain("reference = $1");
	});

	pgTest(
		"routine statistics report language, volatility and returns",
		async () => {
			const result = await adapter.describeObject(
				CONNECTION,
				{
					schema: "shop",
					name: "order_total(order_id integer, vat numeric)",
					kind: "function",
				},
				LIMITS,
			);
			const byLabel = new Map(
				result.statistics.map((stat) => [stat.label, stat.value]),
			);
			expect(byLabel.get("language")).toBe("sql");
			expect(byLabel.get("volatility")).toBe("stable");
			expect(byLabel.get("returns")).toBe("numeric");
			expect(byLabel.get("strict")).toBe("yes");
			expect(byLabel.get("arguments")).toBe("2");
			expect(byLabel.get("comment")).toBe("Gross order total");
		},
	);

	pgTest("a trigger function with no arguments still describes", async () => {
		const result = await adapter.describeObject(
			CONNECTION,
			{ schema: "shop", name: "touch_order()", kind: "function" },
			LIMITS,
		);
		expect(result.arguments).toEqual([]);
		expect(result.ddl).toContain("RETURN NEW");
		expect(
			result.statistics.find((stat) => stat.label === "language")?.value,
		).toBe("plpgsql");
	});

	pgTest(
		"a sequence reports its counter and a rebuilt definition",
		async () => {
			const result = await adapter.describeObject(
				CONNECTION,
				{ schema: "shop", name: "ticket_seq", kind: "sequence" },
				LIMITS,
			);
			expect(result.tabs).toEqual(["statistics", "ddl"]);
			const byLabel = new Map(
				result.statistics.map((stat) => [stat.label, stat.value]),
			);
			expect(byLabel.get("increment")).toBe("5");
			expect(byLabel.get("minimum")).toBe("10");
			expect(byLabel.get("maximum")).toBe("500");
			expect(byLabel.get("cycles")).toBe("yes");
			expect(byLabel.get("type")).toBe("integer");
			// No pg_get_sequencedef exists, so this one is reconstructed.
			expect(result.ddlReconstructed).toBe(true);
			expect(result.ddl).toContain('create sequence "shop"."ticket_seq"');
			expect(result.ddl).toContain("increment by 5");
			expect(result.ddl).toContain("cycle;");
		},
	);

	pgTest("a missing routine is a request error", async () => {
		await expect(
			adapter.describeObject(
				CONNECTION,
				{ schema: "shop", name: "nope()", kind: "function" },
				LIMITS,
			),
		).rejects.toThrow(/was not found/);
	});

	pgTest("describing an object cannot write", async () => {
		// The whole describe runs in a READ ONLY transaction; nothing in it
		// should be able to leave a trace even if a catalog function tried.
		const before = await fixtures`SELECT count(*) AS n FROM shop.orders`;
		await adapter.describeObject(CONNECTION, table, LIMITS);
		const after = await fixtures`SELECT count(*) AS n FROM shop.orders`;
		expect(Number(after[0]?.n)).toBe(Number(before[0]?.n));
	});
});
