import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { SQL } from "bun";
import type { ResolvedConnection, TableLimits } from "../types";
import { PostgresAdapter } from "./adapter";

/**
 * Column changes against a real PostgreSQL instance. PostgreSQL has
 * transactional DDL, so this is also where the "a failed batch changes
 * nothing" claim gets checked for real.
 */

const ADMIN_URL =
	Bun.env.TARGET_TEST_ADMIN_URL ??
	"postgres://datagripe:datagripe@localhost:5432/postgres";
const SCRATCH_DB = "datagripe_alter_test";

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

async function reseed(): Promise<void> {
	await fixtures.unsafe(`
		DROP TABLE IF EXISTS app.widgets CASCADE;
		CREATE TABLE app.widgets (
			id integer PRIMARY KEY,
			label text NOT NULL,
			qty integer DEFAULT 0,
			note text
		);
		COMMENT ON COLUMN app.widgets.label IS 'Display label';
		INSERT INTO app.widgets (id, label, qty) VALUES (1, 'first', 3);
	`);
}

async function columnsOf(): Promise<
	Array<{ name: string; type: string; nullable: boolean; def: string | null }>
> {
	const rows = await fixtures`
		SELECT a.attname AS name,
			format_type(a.atttypid, a.atttypmod) AS type,
			NOT a.attnotnull AS nullable,
			pg_get_expr(d.adbin, d.adrelid) AS def
		FROM pg_attribute a
		JOIN pg_class c ON c.oid = a.attrelid
		JOIN pg_namespace n ON n.oid = c.relnamespace
		LEFT JOIN pg_attrdef d ON d.adrelid = c.oid AND d.adnum = a.attnum
		WHERE n.nspname = 'app' AND c.relname = 'widgets'
			AND a.attnum > 0 AND NOT a.attisdropped
		ORDER BY a.attnum`;
	return rows as never;
}

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
	await fixtures.unsafe("CREATE SCHEMA IF NOT EXISTS app");
	await reseed();
});

afterAll(async () => {
	await adapter.close();
	await fixtures?.close();
	await admin?.close();
});

function request(overrides: Record<string, unknown>) {
	return {
		schema: "app",
		name: "widgets",
		changes: [],
		dryRun: false,
		...overrides,
	} as never;
}

describe("postgres column changes", () => {
	pgTest("a dry run returns the statements and changes nothing", async () => {
		await reseed();
		const result = await adapter.alterColumns(
			CONNECTION,
			request({
				dryRun: true,
				changes: [
					{
						type: "add",
						name: "colour",
						dataType: "text",
						nullable: true,
						defaultExpr: null,
						comment: null,
					},
				],
			}),
			LIMITS,
		);
		expect(result.applied).toBe(0);
		expect(result.statements).toEqual([
			`ALTER TABLE "app"."widgets" ADD COLUMN "colour" text;`,
		]);
		expect((await columnsOf()).map((c) => c.name)).toEqual([
			"id",
			"label",
			"qty",
			"note",
		]);
	});

	pgTest("adding a column applies with its default and comment", async () => {
		await reseed();
		const result = await adapter.alterColumns(
			CONNECTION,
			request({
				changes: [
					{
						type: "add",
						name: "colour",
						dataType: "text",
						nullable: false,
						defaultExpr: "'red'",
						comment: "Paint",
					},
				],
			}),
			LIMITS,
		);
		// The comment is its own statement on postgres.
		expect(result.applied).toBe(2);
		const columns = await columnsOf();
		const colour = columns.find((c) => c.name === "colour");
		expect(colour?.type).toBe("text");
		expect(colour?.nullable).toBe(false);
		expect(colour?.def).toBe("'red'::text");
		const comments = await fixtures`
			SELECT col_description('app.widgets'::regclass, 5) AS comment`;
		expect(comments[0]?.comment).toBe("Paint");
		// The existing row got the default rather than failing NOT NULL.
		const rows = await fixtures`SELECT colour FROM app.widgets WHERE id = 1`;
		expect(rows[0]?.colour).toBe("red");
	});

	pgTest("renaming, retyping and re-defaulting all apply", async () => {
		await reseed();
		// NOT NULL cannot be set while a row holds null, so fill it first —
		// the same order a person would use.
		await fixtures`UPDATE app.widgets SET note = 'filled' WHERE id = 1`;
		const result = await adapter.alterColumns(
			CONNECTION,
			request({
				changes: [
					{ type: "setType", name: "qty", dataType: "bigint" },
					{ type: "setDefault", name: "qty", defaultExpr: "7" },
					{ type: "setNullable", name: "note", nullable: false },
					{ type: "rename", name: "note", newName: "remark" },
				],
			}),
			LIMITS,
		);
		expect(result.applied).toBe(4);
		const columns = await columnsOf();
		const qty = columns.find((c) => c.name === "qty");
		expect(qty?.type).toBe("bigint");
		expect(qty?.def).toBe("7");
		const remark = columns.find((c) => c.name === "remark");
		expect(remark?.nullable).toBe(false);
		expect(columns.some((c) => c.name === "note")).toBe(false);
	});

	pgTest("dropping a column applies", async () => {
		await reseed();
		await adapter.alterColumns(
			CONNECTION,
			request({ changes: [{ type: "drop", name: "note" }] }),
			LIMITS,
		);
		expect((await columnsOf()).map((c) => c.name)).toEqual([
			"id",
			"label",
			"qty",
		]);
	});

	pgTest("a failed batch leaves the table exactly as it was", async () => {
		await reseed();
		await expect(
			adapter.alterColumns(
				CONNECTION,
				request({
					changes: [
						{
							type: "add",
							name: "colour",
							dataType: "text",
							nullable: true,
							defaultExpr: null,
							comment: null,
						},
						// `label` holds 'first', which is not an integer — this
						// statement must fail and take the add with it.
						{ type: "setType", name: "label", dataType: "integer" },
					],
				}),
				LIMITS,
			),
		).rejects.toThrow();
		// Transactional DDL: the successful add rolled back too.
		expect((await columnsOf()).map((c) => c.name)).toEqual([
			"id",
			"label",
			"qty",
			"note",
		]);
	});

	pgTest("the target database's own error comes through", async () => {
		await reseed();
		await expect(
			adapter.alterColumns(
				CONNECTION,
				request({
					changes: [{ type: "setNullable", name: "note", nullable: false }],
				}),
				LIMITS,
			),
		)
			// `note` is null on the seeded row, so postgres refuses and says why.
			.rejects.toThrow(/contains null values/);
	});

	pgTest("a read-only connection previews but will not apply", async () => {
		await reseed();
		const readOnly = { ...CONNECTION, readOnly: true };
		const changes = [{ type: "drop", name: "note" }];
		// A preview runs nothing, so it is allowed.
		const preview = await adapter.alterColumns(
			readOnly,
			request({ changes, dryRun: true }),
			LIMITS,
		);
		expect(preview.statements).toHaveLength(1);
		await expect(
			adapter.alterColumns(readOnly, request({ changes }), LIMITS),
		).rejects.toThrow(/read-only/);
	});

	pgTest("changing a column that is not there is refused", async () => {
		await reseed();
		await expect(
			adapter.alterColumns(
				CONNECTION,
				request({
					changes: [{ type: "drop", name: "no_such_column" }],
					dryRun: true,
				}),
				LIMITS,
			),
		).rejects.toThrow(/Unknown column/);
	});

	pgTest(
		"a default that stacks statements never reaches the server",
		async () => {
			await reseed();
			await expect(
				adapter.alterColumns(
					CONNECTION,
					request({
						changes: [
							{
								type: "setDefault",
								name: "qty",
								defaultExpr: "1; DROP TABLE app.widgets",
							},
						],
						dryRun: true,
					}),
					LIMITS,
				),
			).rejects.toThrow(/single expression/);
			const rows = await fixtures`SELECT count(*) AS n FROM app.widgets`;
			expect(Number(rows[0]?.n)).toBe(1);
		},
	);
});
