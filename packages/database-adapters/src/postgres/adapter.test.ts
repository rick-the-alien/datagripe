import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { SQL } from "bun";
import type { ResolvedConnection } from "../types";
import { PostgresAdapter } from "./adapter";

/**
 * Integration test against a real PostgreSQL instance (CI service or the
 * local compose container). Creates and destroys a scratch database. When
 * no server is reachable every test is skipped.
 */

const ADMIN_URL =
	Bun.env.TARGET_TEST_ADMIN_URL ??
	"postgres://datagripe:datagripe@localhost:5432/postgres";
const SCRATCH_DB = "datagripe_adapter_test";

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
	readOnly: true,
	params: {},
};

const adapter = new PostgresAdapter();

/**
 * One setting's value, read down the adapter's own execution path so the
 * test exercises the client the adapter builds rather than one assembled
 * here to match.
 */
async function currentSetting(
	connection: ResolvedConnection,
	name: string,
): Promise<string> {
	const session = await adapter.beginExecution(connection, {
		timeoutMs: 5_000,
		maxRows: 10,
		maxBytes: 1_000_000,
		batchRows: 10,
		readOnly: false,
		sandbox: false,
	});
	let value = "";
	const result = await session.run(
		[`SELECT current_setting('${name}') AS value`],
		{
			columns: () => {},
			rows: (_resultSet, rows) => {
				value = String(rows[0]?.[0] ?? "");
			},
			statementDone: () => {},
		},
		() => false,
	);
	await session.close();
	if (result.outcome !== "completed") {
		throw new Error(result.error?.message ?? "execution failed");
	}
	return value;
}

let admin: SQL;

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
	const fixtures = new SQL(
		`postgres://datagripe:datagripe@localhost:5432/${SCRATCH_DB}`,
	);
	await fixtures`
		CREATE SCHEMA IF NOT EXISTS app;
	`;
	await fixtures.unsafe(`
		CREATE TABLE IF NOT EXISTS app.users (
			id integer PRIMARY KEY,
			email text NOT NULL,
			display_name text
		);
		CREATE OR REPLACE VIEW app.user_emails AS
			SELECT id, email FROM app.users;
		CREATE OR REPLACE FUNCTION app.user_email_by_id(user_id integer)
			RETURNS text LANGUAGE sql STABLE AS
		$$ SELECT email FROM app.users WHERE id = user_id $$;
		CREATE SEQUENCE IF NOT EXISTS app.user_emails_seq;
	`);
	await fixtures.close();
});

afterAll(async () => {
	await adapter.close();
	await admin?.close();
});

describe("PostgresAdapter", () => {
	pgTest("testConnection reports ok with a server version", async () => {
		const result = await adapter.testConnection(CONNECTION);
		expect(result.ok).toBe(true);
		expect(result.serverVersion).toContain("PostgreSQL");
		expect(result.latencyMs).toBeGreaterThanOrEqual(0);
	});

	pgTest("runtime parameters reach the session", async () => {
		// Measured behaviour, not an assumption: Bun's `connection` option
		// is delivered in the startup packet, so `search_path` is in force
		// before the first statement rather than set by one.
		const withParams: ResolvedConnection = {
			...CONNECTION,
			params: { search_path: "sales,public", application_name: "datagripe" },
		};
		const plain = await currentSetting(CONNECTION, "search_path");
		expect(await currentSetting(withParams, "search_path")).toBe(
			"sales,public",
		);
		expect(await currentSetting(withParams, "application_name")).toBe(
			"datagripe",
		);
		// And the pool is keyed on them: two connections differing only in
		// `search_path` sharing a client would make the same query mean
		// different tables.
		expect(plain).not.toBe("sales,public");
		expect(await currentSetting(CONNECTION, "search_path")).toBe(plain);
	});
	pgTest(
		"an unrecognised runtime parameter fails at connect time",
		async () => {
			// Why the parameter list is an allowlist rather than free-form: this
			// is a FATAL when the connection opens, not a warning, so a typed-in
			// name would be a datasource that cannot connect at all.
			const result = await adapter.testConnection({
				...CONNECTION,
				params: { not_a_setting: "1" } as never,
			});
			expect(result.ok).toBe(false);
			expect(result.error?.message).toContain("not_a_setting");
		},
	);
	pgTest("testConnection reports failure without throwing", async () => {
		// The dev container uses trust auth, so exercise the failure path
		// with a port nothing listens on.
		const result = await adapter.testConnection({
			...CONNECTION,
			port: 54329,
		});
		expect(result.ok).toBe(false);
		expect(result.error?.message.length).toBeGreaterThan(0);
	});

	pgTest(
		"introspects schemas, categories, tables, views, routines, columns",
		async () => {
			const schemas = await adapter.introspectChildren(CONNECTION, []);
			const names = schemas.map((node) => node.name);
			expect(names).toContain("app");
			expect(schemas.every((node) => node.kind === "schema")).toBe(true);

			const categories = await adapter.introspectChildren(CONNECTION, [
				{ kind: "schema", name: "app" },
			]);
			expect(categories.map((node) => node.kind)).toEqual([
				"tables",
				"views",
				"functions",
				"sequences",
			]);

			const tables = await adapter.introspectChildren(CONNECTION, [
				{ kind: "schema", name: "app" },
				{ kind: "tables", name: "tables" },
			]);
			expect(tables).toEqual([
				{ kind: "table", name: "users", hasChildren: true },
			]);

			const views = await adapter.introspectChildren(CONNECTION, [
				{ kind: "schema", name: "app" },
				{ kind: "views", name: "views" },
			]);
			expect(views).toEqual([
				{ kind: "view", name: "user_emails", hasChildren: true },
			]);

			const functions = await adapter.introspectChildren(CONNECTION, [
				{ kind: "schema", name: "app" },
				{ kind: "functions", name: "functions" },
			]);
			expect(functions).toEqual([
				{
					kind: "function",
					name: "user_email_by_id(user_id integer)",
					hasChildren: false,
				},
			]);

			const sequences = await adapter.introspectChildren(CONNECTION, [
				{ kind: "schema", name: "app" },
				{ kind: "sequences", name: "sequences" },
			]);
			expect(sequences).toEqual([
				{ kind: "sequence", name: "user_emails_seq", hasChildren: false },
			]);

			const columns = await adapter.introspectChildren(CONNECTION, [
				{ kind: "schema", name: "app" },
				{ kind: "tables", name: "tables" },
				{ kind: "table", name: "users" },
			]);
			expect(columns).toEqual([
				{
					kind: "column",
					name: "id",
					hasChildren: false,
					dataType: "integer",
					nullable: false,
				},
				{
					kind: "column",
					name: "email",
					hasChildren: false,
					dataType: "text",
					nullable: false,
				},
				{
					kind: "column",
					name: "display_name",
					hasChildren: false,
					dataType: "text",
					nullable: true,
				},
			]);
		},
	);

	pgTest("system schemas are hidden", async () => {
		const schemas = await adapter.introspectChildren(CONNECTION, []);
		const names = schemas.map((node) => node.name);
		expect(names).not.toContain("pg_catalog");
		expect(names).not.toContain("information_schema");
	});

	pgTest("invalid paths are rejected", async () => {
		expect(
			adapter.introspectChildren(CONNECTION, [
				{ kind: "table", name: "users" },
			]),
		).rejects.toThrow("Invalid introspection path");
	});
});
