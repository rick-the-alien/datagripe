import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { SQL } from "bun";
import type { ResolvedConnection, TableLimits } from "../types";
import { MysqlAdapter } from "./adapter";

/**
 * MySQL object view against the local container. Covers what the engine
 * does differently: upper-cased information_schema column names, no
 * per-index size, and verbatim DDL from SHOW CREATE.
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

beforeAll(async () => {
	if (!reachable) {
		return;
	}
	admin = client();
	await admin.unsafe("DROP TABLE IF EXISTS ov_lines");
	await admin.unsafe("DROP VIEW IF EXISTS ov_open");
	await admin.unsafe("DROP TABLE IF EXISTS ov_orders");
	await admin.unsafe(`CREATE TABLE ov_orders (
		id int NOT NULL AUTO_INCREMENT PRIMARY KEY,
		reference varchar(32) NOT NULL COMMENT 'External order reference',
		amount decimal(10,2) NOT NULL DEFAULT 0,
		status varchar(16),
		UNIQUE KEY ov_orders_reference (reference),
		KEY ov_orders_status (status)
	)`);
	await admin.unsafe(`CREATE TABLE ov_lines (
		id int NOT NULL PRIMARY KEY,
		order_id int NOT NULL,
		CONSTRAINT ov_lines_order_fk FOREIGN KEY (order_id) REFERENCES ov_orders (id)
	)`);
	await admin.unsafe(
		"CREATE VIEW ov_open AS SELECT id, reference FROM ov_orders WHERE status = 'open'",
	);
	await admin.unsafe(
		"INSERT INTO ov_orders (reference, amount, status) VALUES ('A-1', 10.00, 'open')",
	);
	await admin.unsafe("DROP FUNCTION IF EXISTS ov_total");
	await admin.unsafe("DROP PROCEDURE IF EXISTS ov_touch");
	await admin.unsafe(
		`CREATE FUNCTION ov_total(order_id INT, vat DECIMAL(4,2))
		 RETURNS DECIMAL(10,2) DETERMINISTIC READS SQL DATA
		 RETURN (SELECT amount * (1 + vat) FROM ov_orders WHERE id = order_id)`,
	);
	await admin.unsafe(
		`CREATE PROCEDURE ov_touch(IN order_id INT)
		 UPDATE ov_orders SET status = 'touched' WHERE id = order_id`,
	);
	await admin.unsafe("ANALYZE TABLE ov_orders");
});

afterAll(async () => {
	await adapter.close();
	await admin?.close();
});

const table = { schema: "demo", name: "ov_orders", kind: "table" as const };

describe("mysql object view", () => {
	myTest("columns carry types, defaults, keys and comments", async () => {
		const result = await adapter.describeObject(CONNECTION, table, LIMITS);
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
		expect(byName.get("id")?.nullable).toBe(false);
		expect(byName.get("amount")?.dataType).toBe("decimal(10,2)");
		expect(byName.get("reference")?.comment).toBe("External order reference");
		expect(byName.get("status")?.comment).toBeNull();
	});

	myTest("indexes group their key columns in order", async () => {
		const result = await adapter.describeObject(CONNECTION, table, LIMITS);
		const primary = result.indexes.find((index) => index.name === "PRIMARY");
		expect(primary?.primary).toBe(true);
		expect(primary?.unique).toBe(true);
		expect(primary?.columns).toBe("id");
		// MySQL exposes no per-index size without InnoDB internals, so the
		// tab says unknown rather than guessing.
		expect(primary?.sizeBytes).toBeNull();

		const status = result.indexes.find(
			(index) => index.name === "ov_orders_status",
		);
		expect(status?.unique).toBe(false);
		expect(status?.method).toBe("btree");
	});

	myTest("constraints render keys and references", async () => {
		const result = await adapter.describeObject(CONNECTION, table, LIMITS);
		const byName = new Map(
			result.constraints.map((constraint) => [
				constraint.name,
				constraint.definition,
			]),
		);
		expect(byName.get("PRIMARY")).toBe("primary key (id)");
		expect(byName.get("ov_orders_reference")).toBe("unique (reference)");
	});

	myTest("a referencing table shows up as a dependent", async () => {
		const result = await adapter.describeObject(CONNECTION, table, LIMITS);
		expect(
			result.dependents.some((dependent) =>
				dependent.name.includes("ov_lines"),
			),
		).toBe(true);
	});

	myTest("DDL comes back verbatim from SHOW CREATE", async () => {
		const result = await adapter.describeObject(CONNECTION, table, LIMITS);
		expect(result.ddlReconstructed).toBe(false);
		expect(result.ddl).toContain("CREATE TABLE");
		expect(result.ddl).toContain("ov_orders");
		expect(result.ddl).toContain("AUTO_INCREMENT");
	});

	myTest("a view reports its own definition and columns", async () => {
		const result = await adapter.describeObject(
			CONNECTION,
			{ schema: "demo", name: "ov_open", kind: "view" },
			LIMITS,
		);
		expect(result.ddl).toContain("VIEW");
		expect(result.columns.map((column) => column.name)).toEqual([
			"id",
			"reference",
		]);
		expect(result.dependents).toEqual([]);
	});

	myTest("statistics tiles report engine and sizes", async () => {
		const result = await adapter.describeObject(CONNECTION, table, LIMITS);
		const labels = result.statistics.map((stat) => stat.label);
		expect(labels).toContain("rows (estimated)");
		expect(labels).toContain("data");
		expect(
			result.statistics.find((stat) => stat.label === "engine")?.value,
		).toBe("InnoDB");
		// table_rows is always an InnoDB estimate.
		expect(result.estimated).toBe(true);
	});

	myTest("grants list roles holding privileges", async () => {
		const result = await adapter.describeObject(CONNECTION, table, LIMITS);
		// The container's root has global grants rather than table grants, so
		// the tab may legitimately be empty — what must not happen is an
		// error or a claim that MySQL cannot answer.
		expect(result.unsupported).toEqual([]);
		expect(Array.isArray(result.grants)).toBe(true);
	});

	myTest("a function's ddl comes back verbatim from SHOW CREATE", async () => {
		const result = await adapter.describeObject(
			CONNECTION,
			{ schema: "demo", name: "ov_total", kind: "function" },
			LIMITS,
		);
		expect(result.ddlReconstructed).toBe(false);
		expect(result.ddl).toContain("CREATE");
		expect(result.ddl).toContain("ov_total");
		expect(result.ddl).toContain("RETURN");
		expect(result.tabs).toEqual(["arguments", "grants", "statistics", "ddl"]);
	});

	myTest("function arguments carry name, type and mode", async () => {
		const result = await adapter.describeObject(
			CONNECTION,
			{ schema: "demo", name: "ov_total", kind: "function" },
			LIMITS,
		);
		expect(result.arguments.map((argument) => argument.name)).toEqual([
			"order_id",
			"vat",
		]);
		expect(result.arguments[0]?.mode).toBe("in");
		const byLabel = new Map(
			result.statistics.map((stat) => [stat.label, stat.value]),
		);
		expect(byLabel.get("deterministic")).toBe("yes");
		expect(byLabel.get("returns")).toBe("decimal(10,2)");
	});

	myTest("a procedure describes through the same path", async () => {
		const result = await adapter.describeObject(
			CONNECTION,
			{ schema: "demo", name: "ov_touch", kind: "procedure" },
			LIMITS,
		);
		expect(result.ddl).toContain("PROCEDURE");
		expect(result.arguments.map((argument) => argument.name)).toEqual([
			"order_id",
		]);
	});

	myTest("mysql has no sequences to describe", async () => {
		await expect(
			adapter.describeObject(
				CONNECTION,
				{ schema: "demo", name: "whatever", kind: "sequence" },
				LIMITS,
			),
		).rejects.toThrow(/Cannot describe/);
	});

	myTest("a missing relation is a request error", async () => {
		await expect(
			adapter.describeObject(
				CONNECTION,
				{ schema: "demo", name: "no_such_table", kind: "table" },
				LIMITS,
			),
		).rejects.toThrow(/was not found/);
	});
});
