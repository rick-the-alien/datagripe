import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { SQL } from "bun";
import type { ResolvedConnection } from "../types";
import { SqliteAdapter } from "./adapter";

/** SQLite adapter integration test against a temp-file database. */

let dir: string;
let connection: ResolvedConnection;
const adapter = new SqliteAdapter();

beforeAll(async () => {
	dir = await mkdtemp(path.join(tmpdir(), "datagripe-sqlite-"));
	const file = path.join(dir, "demo.db");
	const setup = new SQL({ adapter: "sqlite", filename: file });
	await setup.unsafe(
		"CREATE TABLE products (id INTEGER PRIMARY KEY, sku TEXT NOT NULL UNIQUE, title TEXT NOT NULL, price_cents INTEGER NOT NULL DEFAULT 0)",
	);
	await setup.unsafe(
		"INSERT INTO products (id, sku, title, price_cents) VALUES (1, 'SKU-1', 'Widget', 1999), (2, 'SKU-2', 'Gadget', 4990)",
	);
	await setup.unsafe(
		"CREATE VIEW product_skus AS SELECT id, sku FROM products",
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

describe("SqliteAdapter", () => {
	test("testConnection reports the SQLite version", async () => {
		const result = await adapter.testConnection(connection);
		expect(result.ok).toBe(true);
		expect(result.serverVersion).toContain("SQLite 3.");
	});

	test("introspects schemas, tables, views, columns", async () => {
		const schemas = await adapter.introspectChildren(connection, []);
		expect(schemas.map((n) => n.name)).toContain("main");

		const tables = await adapter.introspectChildren(connection, [
			{ kind: "schema", name: "main" },
			{ kind: "tables", name: "tables" },
		]);
		expect(tables).toEqual([
			{ kind: "table", name: "products", hasChildren: true },
		]);

		const views = await adapter.introspectChildren(connection, [
			{ kind: "schema", name: "main" },
			{ kind: "views", name: "views" },
		]);
		expect(views).toEqual([
			{ kind: "view", name: "product_skus", hasChildren: true },
		]);

		const columns = await adapter.introspectChildren(connection, [
			{ kind: "schema", name: "main" },
			{ kind: "tables", name: "tables" },
			{ kind: "table", name: "products" },
		]);
		expect(columns).toEqual([
			{
				kind: "column",
				name: "id",
				hasChildren: false,
				dataType: "INTEGER",
				nullable: true,
			},
			{
				kind: "column",
				name: "sku",
				hasChildren: false,
				dataType: "TEXT",
				nullable: false,
			},
			{
				kind: "column",
				name: "title",
				hasChildren: false,
				dataType: "TEXT",
				nullable: false,
			},
			{
				kind: "column",
				name: "price_cents",
				hasChildren: false,
				dataType: "INTEGER",
				nullable: false,
			},
		]);
	});

	test("buffered execution streams rows and completes", async () => {
		const session = await adapter.beginExecution(connection, {
			timeoutMs: 5_000,
			maxRows: 100,
			maxBytes: 1_000_000,
			batchRows: 500,
			readOnly: false,
		});
		const events: Array<{ kind: string; payload: unknown }> = [];
		const result = await session.run(
			["select id, sku from products order by id"],
			{
				columns: (_rs, columns) =>
					events.push({ kind: "columns", payload: columns }),
				rows: (_rs, rows) => events.push({ kind: "rows", payload: rows }),
				statementDone: () => {},
			},
			() => false,
		);
		expect(result.outcome).toBe("completed");
		expect(events[0]?.kind).toBe("columns");
		const rows = events.find((e) => e.kind === "rows")?.payload as unknown[][];
		expect(rows).toHaveLength(2);
		expect(rows[1]).toContain("SKU-2");
		await session.close();
	});

	test("row cap truncates buffered results", async () => {
		const session = await adapter.beginExecution(connection, {
			timeoutMs: 5_000,
			maxRows: 1,
			maxBytes: 1_000_000,
			batchRows: 500,
			readOnly: false,
		});
		const result = await session.run(
			["select id from products order by id"],
			{ columns: () => {}, rows: () => {}, statementDone: () => {} },
			() => false,
		);
		expect(result.outcome).toBe("completed");
		expect(result.truncated).toBe(true);
		expect(result.rowCount).toBe(1);
		await session.close();
	});

	test("syntax error fails with the database message", async () => {
		const session = await adapter.beginExecution(connection, {
			timeoutMs: 5_000,
			maxRows: 100,
			maxBytes: 1_000_000,
			batchRows: 500,
			readOnly: false,
		});
		const result = await session.run(
			["select * from missing_table"],
			{ columns: () => {}, rows: () => {}, statementDone: () => {} },
			() => false,
		);
		expect(result.outcome).toBe("failed");
		expect(result.error?.message).toContain("missing_table");
		await session.close();
	});
});
