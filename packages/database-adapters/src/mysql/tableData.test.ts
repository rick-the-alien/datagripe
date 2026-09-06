import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { SQL } from "bun";
import type { ResolvedConnection, TableLimits } from "../types";
import { MysqlAdapter } from "./adapter";

/**
 * MySQL table view against the local container. Covers what the dialect
 * does differently: backtick identifiers, `?` placeholders,
 * `() VALUES ()` for an all-defaults insert, and no `SET col = DEFAULT`.
 */

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

const LIMITS: TableLimits = {
	timeoutMs: 10_000,
	maxRows: 500,
	estimateAboveRows: 100_000,
};

function client(): SQL {
	return new SQL({
		adapter: "mysql",
		hostname: CONNECTION.host,
		port: CONNECTION.port,
		database: CONNECTION.database,
		username: CONNECTION.username,
		password: CONNECTION.password,
		allowPublicKeyRetrieval: true,
		connectionTimeout: 2,
	});
}

async function probe(): Promise<boolean> {
	try {
		const sql = client();
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
let admin: SQL;

async function reseed(): Promise<void> {
	await admin.unsafe("DELETE FROM tv_orders");
	await admin.unsafe(
		"INSERT INTO tv_orders (id, sku, cents) VALUES (1, 'SKU-1', 1999), (2, 'SKU-2', 4990)",
	);
}

beforeAll(async () => {
	if (!reachable) {
		return;
	}
	admin = client();
	await admin.unsafe("DROP TABLE IF EXISTS tv_orders");
	await admin.unsafe("DROP TABLE IF EXISTS tv_keyless");
	await admin.unsafe(`CREATE TABLE tv_orders (
		id int NOT NULL AUTO_INCREMENT PRIMARY KEY,
		sku varchar(32) NOT NULL,
		cents int NOT NULL DEFAULT 0,
		major decimal(10,2) AS (cents / 100) STORED
	)`);
	await admin.unsafe("CREATE TABLE tv_keyless (label varchar(32))");
	await reseed();
});

afterAll(async () => {
	await adapter.close();
	await admin?.close();
});

function request(overrides: Record<string, unknown> = {}) {
	return {
		schema: "demo",
		table: "tv_orders",
		kind: "table" as const,
		limit: 100,
		offset: 0,
		sort: [],
		filter: "",
		count: true,
		...overrides,
	};
}

describe("mysql table view", () => {
	myTest("reads columns with key, generated and default flags", async () => {
		const result = await adapter.readTable(CONNECTION, request(), LIMITS);
		expect(result.columns.map((column) => column.name)).toEqual([
			"id",
			"sku",
			"cents",
			"major",
		]);
		const byName = new Map(
			result.columns.map((column) => [column.name, column]),
		);
		expect(byName.get("id")?.primaryKey).toBe(true);
		// auto_increment is a default, not a generated column: it stays
		// writable but can be left out on insert.
		expect(byName.get("id")?.hasDefault).toBe(true);
		expect(byName.get("id")?.generated).toBe(false);
		expect(byName.get("major")?.generated).toBe(true);
		expect(byName.get("cents")?.hasDefault).toBe(true);
		expect(result.editable).toBe(true);
	});

	myTest("sorts, filters and counts server-side", async () => {
		await reseed();
		const sorted = await adapter.readTable(
			CONNECTION,
			request({ sort: [{ column: "cents", direction: "desc" }] }),
			LIMITS,
		);
		expect(sorted.rows.map((row) => row[0])).toEqual([2, 1]);

		const filtered = await adapter.readTable(
			CONNECTION,
			request({ filter: "cents > 2000" }),
			LIMITS,
		);
		expect(filtered.totalRows).toBe(1);
		expect(filtered.estimated).toBe(false);
	});

	myTest("writes an update, an all-defaults insert and a delete", async () => {
		await reseed();
		const outcome = await adapter.mutateTable(
			CONNECTION,
			{
				schema: "demo",
				table: "tv_orders",
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
							cents: { kind: "default" },
						},
					},
					{ type: "delete", key: { id: { kind: "text", text: "2" } } },
				],
			},
			LIMITS,
		);
		expect(outcome.applied).toBe(3);

		const after = await adapter.readTable(
			CONNECTION,
			request({ sort: [{ column: "id", direction: "asc" }] }),
			LIMITS,
		);
		expect(after.rows.map((row) => row[1])).toEqual(["SKU-1-B", "SKU-3"]);
		expect(Number(after.rows[1]?.[2])).toBe(0);
	});

	myTest(
		"update-to-default is refused rather than half-supported",
		async () => {
			await reseed();
			await expect(
				adapter.mutateTable(
					CONNECTION,
					{
						schema: "demo",
						table: "tv_orders",
						edits: [
							{
								type: "update",
								key: { id: { kind: "text", text: "1" } },
								values: { cents: { kind: "default" } },
							},
						],
					},
					LIMITS,
				),
			).rejects.toThrow(/cannot be set to DEFAULT/);
		},
	);

	myTest("a keyless table is browsable but not editable", async () => {
		const result = await adapter.readTable(
			CONNECTION,
			request({ table: "tv_keyless" }),
			LIMITS,
		);
		expect(result.editable).toBe(false);
		expect(result.reason).toMatch(/primary key/);
	});

	myTest("a stacked filter is rejected", async () => {
		await expect(
			adapter.readTable(
				CONNECTION,
				request({ filter: "1=1; DROP TABLE tv_orders" }),
				LIMITS,
			),
		).rejects.toThrow(/single expression/);
	});
});
