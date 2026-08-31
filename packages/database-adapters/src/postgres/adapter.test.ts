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
};

const adapter = new PostgresAdapter();
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
		"introspects schemas, categories, tables, views, columns",
		async () => {
			const schemas = await adapter.introspectChildren(CONNECTION, []);
			const names = schemas.map((node) => node.name);
			expect(names).toContain("app");
			expect(schemas.every((node) => node.kind === "schema")).toBe(true);

			const categories = await adapter.introspectChildren(CONNECTION, [
				{ kind: "schema", name: "app" },
			]);
			expect(categories.map((node) => node.kind)).toEqual(["tables", "views"]);

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
