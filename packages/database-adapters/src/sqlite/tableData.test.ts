import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { SQL } from "bun";
import type { ResolvedConnection, TableLimits } from "../types";
import { SqliteAdapter } from "./adapter";

/**
 * SQLite table view against a temp-file database. Covers what the
 * dialect does differently: `?` placeholders, `PRAGMA table_xinfo` for
 * generated columns, and no planner estimate to prefer over COUNT(*).
 */

const LIMITS: TableLimits = {
	timeoutMs: 10_000,
	maxRows: 500,
	estimateAboveRows: 100_000,
};

let dir: string;
let file: string;
let connection: ResolvedConnection;
const adapter = new SqliteAdapter();

async function reseed(): Promise<void> {
	const setup = new SQL({ adapter: "sqlite", filename: file });
	await setup.unsafe("DELETE FROM products");
	await setup.unsafe(
		"INSERT INTO products (id, sku, price_cents) VALUES (1, 'SKU-1', 1999), (2, 'SKU-2', 4990)",
	);
	await setup.close();
}

beforeAll(async () => {
	dir = await mkdtemp(path.join(tmpdir(), "datagripe-sqlite-table-"));
	file = path.join(dir, "demo.db");
	const setup = new SQL({ adapter: "sqlite", filename: file });
	await setup.unsafe(`CREATE TABLE products (
		id INTEGER PRIMARY KEY,
		sku TEXT NOT NULL,
		price_cents INTEGER NOT NULL DEFAULT 0,
		price_major REAL GENERATED ALWAYS AS (price_cents / 100.0) STORED
	)`);
	await setup.unsafe("CREATE TABLE keyless (label TEXT)");
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
	await reseed();
});

afterAll(async () => {
	await adapter.close();
	await rm(dir, { recursive: true, force: true });
});

function request(overrides: Record<string, unknown> = {}) {
	return {
		schema: "main",
		table: "products",
		kind: "table" as const,
		limit: 100,
		offset: 0,
		sort: [],
		filter: "",
		count: true,
		...overrides,
	};
}

describe("sqlite table view", () => {
	test("reads columns, marking the generated one", async () => {
		const result = await adapter.readTable(connection, request(), LIMITS);
		expect(result.columns.map((column) => column.name)).toEqual([
			"id",
			"sku",
			"price_cents",
			"price_major",
		]);
		const byName = new Map(
			result.columns.map((column) => [column.name, column]),
		);
		expect(byName.get("id")?.primaryKey).toBe(true);
		expect(byName.get("price_cents")?.hasDefault).toBe(true);
		expect(byName.get("price_major")?.generated).toBe(true);
		expect(result.editable).toBe(true);
		expect(result.totalRows).toBe(2);
		expect(result.estimated).toBe(false);
	});

	test("sorts and filters server-side", async () => {
		await reseed();
		const sorted = await adapter.readTable(
			connection,
			request({ sort: [{ column: "price_cents", direction: "desc" }] }),
			LIMITS,
		);
		expect(sorted.rows.map((row) => row[0])).toEqual([2, 1]);

		const filtered = await adapter.readTable(
			connection,
			request({ filter: "price_cents > 2000" }),
			LIMITS,
		);
		expect(filtered.totalRows).toBe(1);
	});

	test("writes an update, insert and delete", async () => {
		await reseed();
		const outcome = await adapter.mutateTable(connection, {
			schema: "main",
			table: "products",
			edits: [
				{
					type: "update",
					key: { id: { kind: "text", text: "1" } },
					values: { sku: { kind: "text", text: "SKU-1-B" } },
				},
				{
					type: "insert",
					values: {
						sku: { kind: "text", text: "SKU-3" },
						price_cents: { kind: "default" },
					},
				},
				{ type: "delete", key: { id: { kind: "text", text: "2" } } },
			],
		});
		expect(outcome.applied).toBe(3);

		const after = await adapter.readTable(
			connection,
			request({ sort: [{ column: "id", direction: "asc" }] }),
			LIMITS,
		);
		expect(after.rows.map((row) => row[1])).toEqual(["SKU-1-B", "SKU-3"]);
		// The default filled in, and the generated column followed.
		expect(after.rows[1]?.[2]).toBe(0);
		expect(after.rows[1]?.[3]).toBe(0);
	});

	test("a keyless table is browsable but not editable", async () => {
		const result = await adapter.readTable(
			connection,
			request({ table: "keyless" }),
			LIMITS,
		);
		expect(result.editable).toBe(false);
		expect(result.reason).toMatch(/primary key/);
	});

	test("a read-only connection refuses to mutate", async () => {
		await expect(
			adapter.mutateTable(
				{ ...connection, readOnly: true },
				{
					schema: "main",
					table: "products",
					edits: [{ type: "delete", key: { id: { kind: "text", text: "1" } } }],
				},
			),
		).rejects.toThrow(/read-only/);
	});
});
