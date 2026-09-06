import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { SQL } from "bun";
import type { ResolvedConnection } from "../types";
import { SqliteAdapter } from "./adapter";
import { parseTriggerHeader } from "./objectData";

/**
 * SQLite object view against a temp-file database. Covers what the
 * engine does differently: PRAGMA-derived metadata, verbatim DDL from
 * sqlite_master, and no permission system at all.
 */

let dir: string;
let connection: ResolvedConnection;
const adapter = new SqliteAdapter();

beforeAll(async () => {
	dir = await mkdtemp(path.join(tmpdir(), "datagripe-sqlite-object-"));
	const file = path.join(dir, "demo.db");
	const setup = new SQL({ adapter: "sqlite", filename: file });
	await setup.unsafe(`CREATE TABLE orders (
		id INTEGER PRIMARY KEY,
		reference TEXT NOT NULL,
		amount REAL NOT NULL DEFAULT 0,
		status TEXT
	)`);
	await setup.unsafe(
		"CREATE UNIQUE INDEX orders_reference ON orders (reference)",
	);
	await setup.unsafe("CREATE INDEX orders_status ON orders (status)");
	await setup.unsafe(`CREATE TABLE lines (
		id INTEGER PRIMARY KEY,
		order_id INTEGER NOT NULL REFERENCES orders (id)
	)`);
	await setup.unsafe(
		`CREATE TRIGGER orders_touch AFTER UPDATE ON orders
		 BEGIN SELECT 1; END`,
	);
	await setup.unsafe(
		"INSERT INTO orders (id, reference, amount, status) VALUES (1, 'A-1', 10.0, 'open')",
	);
	await setup.close();
	connection = {
		adapter: "sqlite",
		host: "",
		port: 0,
		database: file,
		username: "",
		password: "",
		tlsMode: "disable",
		readOnly: false,
	};
});

afterAll(async () => {
	await adapter.close();
	await rm(dir, { recursive: true, force: true });
});

const table = { schema: "main", name: "orders", kind: "table" as const };

describe("parseTriggerHeader", () => {
	test("reads timing and event out of the stored CREATE text", () => {
		expect(
			parseTriggerHeader("CREATE TRIGGER t AFTER UPDATE ON orders BEGIN END"),
		).toEqual({ timing: "after", events: "update" });
		expect(
			parseTriggerHeader("CREATE TRIGGER t BEFORE INSERT ON orders BEGIN END"),
		).toEqual({ timing: "before", events: "insert" });
		expect(
			parseTriggerHeader("CREATE TRIGGER t INSTEAD OF DELETE ON v BEGIN END")
				.timing,
		).toBe("instead of");
	});

	test("an unparseable header still yields a listable trigger", () => {
		expect(parseTriggerHeader("something else entirely")).toEqual({
			timing: "",
			events: "",
		});
	});
});

describe("sqlite object view", () => {
	test("columns carry types, defaults and keys", async () => {
		const result = await adapter.describeObject(connection, table);
		expect(result.columns.map((column) => column.name)).toEqual([
			"id",
			"reference",
			"amount",
			"status",
		]);
		const byName = new Map(
			result.columns.map((column) => [column.name, column]),
		);
		expect(byName.get("id")?.primaryKey).toBe(true);
		expect(byName.get("amount")?.defaultExpr).toBe("0");
		expect(byName.get("status")?.nullable).toBe(true);
		// SQLite has no column comments at all.
		expect(byName.get("reference")?.comment).toBeNull();
	});

	test("indexes list their key columns and uniqueness", async () => {
		const result = await adapter.describeObject(connection, table);
		const unique = result.indexes.find(
			(index) => index.name === "orders_reference",
		);
		expect(unique?.unique).toBe(true);
		expect(unique?.columns).toBe("reference");
		expect(unique?.method).toBe("btree");

		const plain = result.indexes.find(
			(index) => index.name === "orders_status",
		);
		expect(plain?.unique).toBe(false);
	});

	test("constraints are derived from keys, indexes and foreign keys", async () => {
		const result = await adapter.describeObject(connection, table);
		const types = result.constraints.map((constraint) => constraint.type);
		expect(types).toContain("primary key");
		expect(types).toContain("unique");

		const child = await adapter.describeObject(connection, {
			schema: "main",
			name: "lines",
			kind: "table",
		});
		const foreign = child.constraints.find(
			(constraint) => constraint.type === "foreign key",
		);
		expect(foreign?.definition).toBe(
			"foreign key (order_id) references orders (id)",
		);
	});

	test("triggers are read back out of their stored SQL", async () => {
		const result = await adapter.describeObject(connection, table);
		const trigger = result.triggers.find(
			(entry) => entry.name === "orders_touch",
		);
		expect(trigger?.timing).toBe("after");
		expect(trigger?.events).toBe("update");
		expect(trigger?.action).toContain("CREATE TRIGGER");
	});

	test("grants are reported unsupported, not empty", async () => {
		const result = await adapter.describeObject(connection, table);
		// SQLite has no permission system; an empty tab would imply there
		// simply are no grants, which is a different claim.
		expect(result.unsupported).toContain("grants");
		expect(result.grants).toEqual([]);
	});

	test("DDL comes back verbatim from sqlite_master", async () => {
		const result = await adapter.describeObject(connection, table);
		expect(result.ddlReconstructed).toBe(false);
		expect(result.ddl).toContain("CREATE TABLE orders");
	});

	test("row count is exact, since a local file can afford it", async () => {
		const result = await adapter.describeObject(connection, table);
		expect(result.rowEstimate).toBe(1);
		expect(result.estimated).toBe(false);
		expect(result.statistics.find((stat) => stat.label === "rows")?.value).toBe(
			"1",
		);
	});

	test("a referencing table shows up as a dependent", async () => {
		const result = await adapter.describeObject(connection, table);
		expect(result.dependents).toEqual([{ kind: "foreign key", name: "lines" }]);
	});

	test("a missing relation is a request error", async () => {
		await expect(
			adapter.describeObject(connection, {
				schema: "main",
				name: "no_such_table",
				kind: "table",
			}),
		).rejects.toThrow(/was not found/);
	});
});
