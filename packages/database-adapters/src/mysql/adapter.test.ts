import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { SQL } from "bun";
import type { ResolvedConnection } from "../types";
import { MysqlAdapter } from "./adapter";

/** MySQL adapter integration test against the local container. */

const CONNECTION: ResolvedConnection = {
	adapter: "mysql",
	host: "localhost",
	port: 3306,
	database: "demo",
	username: "root",
	password: "datagripe",
	tlsMode: "disable",
	readOnly: false,
};

async function probe(): Promise<boolean> {
	try {
		const sql = new SQL({
			adapter: "mysql",
			hostname: CONNECTION.host,
			port: CONNECTION.port,
			database: CONNECTION.database,
			username: CONNECTION.username,
			password: CONNECTION.password,
			allowPublicKeyRetrieval: true,
			connectionTimeout: 2,
		});
		await sql`SELECT 1`;
		await sql.close();
		return true;
	} catch {
		return false;
	}
}

const reachable = await probe();
const myTest = reachable ? test : test.skip;

const adapter = new MysqlAdapter();

beforeAll(async () => {
	if (!reachable) {
		return;
	}
	// Fixtures are idempotent (created by the dev setup; enforce here so CI
	// works against a fresh container too).
	const admin = new SQL({
		adapter: "mysql",
		hostname: CONNECTION.host,
		port: CONNECTION.port,
		username: CONNECTION.username,
		password: CONNECTION.password,
		allowPublicKeyRetrieval: true,
	});
	await admin.unsafe("CREATE SCHEMA IF NOT EXISTS shop");
	await admin.unsafe(
		"CREATE TABLE IF NOT EXISTS shop.products (id INT PRIMARY KEY AUTO_INCREMENT, sku VARCHAR(32) NOT NULL UNIQUE, title VARCHAR(255) NOT NULL, price_cents INT NOT NULL DEFAULT 0)",
	);
	await admin.unsafe(
		"CREATE OR REPLACE VIEW shop.product_skus AS SELECT id, sku FROM shop.products",
	);
	await admin.unsafe(
		"INSERT IGNORE INTO shop.products (id, sku, title, price_cents) VALUES (1,'SKU-1','Widget',1999),(2,'SKU-2','Gadget',4990)",
	);
	await admin.close();
});

afterAll(async () => {
	await adapter.close();
});

describe("MysqlAdapter", () => {
	myTest("testConnection reports ok with a server version", async () => {
		const result = await adapter.testConnection(CONNECTION);
		expect(result.ok).toBe(true);
		expect(result.serverVersion).toContain("8.");
	});

	myTest("testConnection reports failure without throwing", async () => {
		const result = await adapter.testConnection({
			...CONNECTION,
			port: 33306,
		});
		expect(result.ok).toBe(false);
	});

	myTest("introspects schemas, tables, views, columns", async () => {
		const schemas = await adapter.introspectChildren(CONNECTION, []);
		expect(schemas.map((n) => n.name)).toContain("shop");
		expect(schemas.map((n) => n.name)).not.toContain("mysql");

		const tables = await adapter.introspectChildren(CONNECTION, [
			{ kind: "schema", name: "shop" },
			{ kind: "tables", name: "tables" },
		]);
		expect(tables).toEqual([
			{ kind: "table", name: "products", hasChildren: true },
		]);

		const views = await adapter.introspectChildren(CONNECTION, [
			{ kind: "schema", name: "shop" },
			{ kind: "views", name: "views" },
		]);
		expect(views).toEqual([
			{ kind: "view", name: "product_skus", hasChildren: true },
		]);

		const columns = await adapter.introspectChildren(CONNECTION, [
			{ kind: "schema", name: "shop" },
			{ kind: "tables", name: "tables" },
			{ kind: "table", name: "products" },
		]);
		expect(columns.map((c) => c.name)).toEqual([
			"id",
			"sku",
			"title",
			"price_cents",
		]);
		expect(columns[1]).toMatchObject({ dataType: "varchar", nullable: false });
	});

	myTest("buffered execution streams rows and completes", async () => {
		const session = await adapter.beginExecution(CONNECTION, {
			timeoutMs: 5_000,
			maxRows: 100,
			maxBytes: 1_000_000,
			batchRows: 500,
			readOnly: false,
		});
		const events: Array<{ kind: string; payload: unknown }> = [];
		const result = await session.run(
			["select id, sku, title from shop.products order by id"],
			{
				columns: (_rs, columns) =>
					events.push({ kind: "columns", payload: columns }),
				rows: (_rs, rows) => events.push({ kind: "rows", payload: rows }),
				statementDone: (_i, info) =>
					events.push({ kind: "done", payload: info }),
			},
			() => false,
		);
		expect(result.outcome).toBe("completed");
		const columns = events.find((e) => e.kind === "columns")?.payload as Array<{
			name: string;
		}>;
		expect(columns.map((c) => c.name)).toEqual(["id", "sku", "title"]);
		const rows = events.find((e) => e.kind === "rows")?.payload as unknown[][];
		expect(rows).toHaveLength(2);
		expect(rows[0]).toContain("SKU-1");
		await session.close();
	});

	myTest("row cap truncates buffered results", async () => {
		const session = await adapter.beginExecution(CONNECTION, {
			timeoutMs: 5_000,
			maxRows: 1,
			maxBytes: 1_000_000,
			batchRows: 500,
			readOnly: false,
		});
		const result = await session.run(
			[
				"select id from shop.products union all select id + 100 from shop.products order by id",
			],
			{ columns: () => {}, rows: () => {}, statementDone: () => {} },
			() => false,
		);
		expect(result.outcome).toBe("completed");
		expect(result.truncated).toBe(true);
		expect(result.rowCount).toBe(1);
		await session.close();
	});

	myTest("KILL QUERY cancels a running statement", async () => {
		const session = await adapter.beginExecution(CONNECTION, {
			timeoutMs: 30_000,
			maxRows: 100,
			maxBytes: 1_000_000,
			batchRows: 500,
			readOnly: false,
		});
		const before = Date.now();
		const running = session.run(
			["select SLEEP(30)"],
			{ columns: () => {}, rows: () => {}, statementDone: () => {} },
			() => false,
		);
		await new Promise((resolve) => setTimeout(resolve, 500));
		await session.cancel();
		const result = await running;
		expect(Date.now() - before).toBeLessThan(10_000);
		expect(result.outcome).toBe("cancelled");
		await session.close();
	});

	myTest("statement timeout fails with QUERY_TIMEOUT", async () => {
		const session = await adapter.beginExecution(CONNECTION, {
			timeoutMs: 500,
			maxRows: 100,
			maxBytes: 1_000_000,
			batchRows: 500,
			readOnly: false,
		});
		const result = await session.run(
			["select SLEEP(5)"],
			{ columns: () => {}, rows: () => {}, statementDone: () => {} },
			() => false,
		);
		expect(result.outcome).toBe("failed");
		expect(result.error?.code).toBe("QUERY_TIMEOUT");
		await session.close();
	});
});
