import { describe, expect, test } from "bun:test";
import type { TableColumn } from "@datagripe/contracts";
import type { TableLimits } from "../types";
import { POSTGRES_TABLE_DIALECT, TableRequestError } from "./builder";
import {
	applyTableEdits,
	keyColumnsOf,
	normalizeCell,
	readTablePage,
	type TableCatalog,
	type TableSession,
} from "./data";

const COLUMNS: TableColumn[] = [
	{
		name: "id",
		dataType: "integer",
		nullable: false,
		primaryKey: true,
		generated: false,
		hasDefault: true,
	},
	{
		name: "amount",
		dataType: "numeric",
		nullable: true,
		primaryKey: false,
		generated: false,
		hasDefault: false,
	},
];

const LIMITS: TableLimits = {
	timeoutMs: 5_000,
	maxRows: 500,
	estimateAboveRows: 1_000,
};

/** Records every statement so the flow can be asserted without a server. */
function fakeSession(options: {
	rows?: Array<Record<string, unknown>>;
	total?: number;
	affected?: number | undefined;
}): TableSession & { log: string[] } {
	const log: string[] = [];
	return {
		log,
		query: async (sql) => {
			log.push(sql);
			if (sql.startsWith("SELECT count(*)")) {
				return [{ dg_total: options.total ?? 0 }];
			}
			return options.rows ?? [];
		},
		write: async (sql) => {
			log.push(sql);
			return options.affected;
		},
	};
}

function catalogFor(columns: TableColumn[], estimate?: number): TableCatalog {
	return {
		supportsUpdateDefault: true,
		describe: async () => columns,
		...(estimate === undefined ? {} : { estimate: async () => estimate }),
	};
}

describe("normalizeCell", () => {
	test("bigint becomes a string so JSON serialisation survives", () => {
		expect(normalizeCell(9_007_199_254_740_993n)).toBe("9007199254740993");
	});

	test("a Date becomes an ISO string", () => {
		expect(normalizeCell(new Date("2026-09-05T10:00:00.000Z"))).toBe(
			"2026-09-05T10:00:00.000Z",
		);
	});

	test("bytes become a hex literal", () => {
		expect(normalizeCell(new Uint8Array([0xde, 0xad]))).toBe("\\xdead");
	});

	test("undefined becomes null, and zero stays zero", () => {
		expect(normalizeCell(undefined)).toBeNull();
		expect(normalizeCell(0)).toBe(0);
		expect(normalizeCell(false)).toBe(false);
	});
});

describe("readTablePage", () => {
	test("maps object rows into column-ordered arrays", async () => {
		const session = fakeSession({
			rows: [
				{ id: 1, amount: "10.00" },
				{ id: 2, amount: null },
			],
			total: 2,
		});
		const result = await readTablePage({
			session,
			dialect: POSTGRES_TABLE_DIALECT,
			catalog: catalogFor(COLUMNS),
			request: {
				schema: "public",
				table: "payments",
				kind: "table",
				limit: 100,
				offset: 0,
				sort: [],
				filter: "",
				count: true,
			},
			limits: LIMITS,
			readOnlyConnection: false,
		});
		expect(result.rows).toEqual([
			[1, "10.00"],
			[2, null],
		]);
		expect(result.totalRows).toBe(2);
		expect(result.estimated).toBe(false);
		expect(result.editable).toBe(true);
	});

	test("the requested limit is clamped to the server cap", async () => {
		const session = fakeSession({ rows: [] });
		await readTablePage({
			session,
			dialect: POSTGRES_TABLE_DIALECT,
			catalog: catalogFor(COLUMNS),
			request: {
				schema: "public",
				table: "payments",
				kind: "table",
				limit: 5_000,
				offset: 0,
				sort: [],
				filter: "",
				count: false,
			},
			limits: LIMITS,
			readOnlyConnection: false,
		});
		expect(session.log.some((sql) => sql.includes("LIMIT 500"))).toBe(true);
	});

	test("a big unfiltered table reports the planner estimate, not a count", async () => {
		const session = fakeSession({ rows: [], total: 42 });
		const result = await readTablePage({
			session,
			dialect: POSTGRES_TABLE_DIALECT,
			catalog: catalogFor(COLUMNS, 41_203_882),
			request: {
				schema: "public",
				table: "payments",
				kind: "table",
				limit: 100,
				offset: 0,
				sort: [],
				filter: "",
				count: true,
			},
			limits: LIMITS,
			readOnlyConnection: false,
		});
		expect(result.totalRows).toBe(41_203_882);
		expect(result.estimated).toBe(true);
		expect(session.log.some((sql) => sql.startsWith("SELECT count(*)"))).toBe(
			false,
		);
	});

	test("a filter forces an exact count even on a big table", async () => {
		const session = fakeSession({ rows: [], total: 12 });
		const result = await readTablePage({
			session,
			dialect: POSTGRES_TABLE_DIALECT,
			catalog: catalogFor(COLUMNS, 41_203_882),
			request: {
				schema: "public",
				table: "payments",
				kind: "table",
				limit: 100,
				offset: 0,
				sort: [],
				filter: "amount > 100",
				count: true,
			},
			limits: LIMITS,
			readOnlyConnection: false,
		});
		expect(result.totalRows).toBe(12);
		expect(result.estimated).toBe(false);
	});

	test("a read-only connection reports why the grid cannot be edited", async () => {
		const result = await readTablePage({
			session: fakeSession({ rows: [] }),
			dialect: POSTGRES_TABLE_DIALECT,
			catalog: catalogFor(COLUMNS),
			request: {
				schema: "public",
				table: "payments",
				kind: "table",
				limit: 100,
				offset: 0,
				sort: [],
				filter: "",
				count: false,
			},
			limits: LIMITS,
			readOnlyConnection: true,
		});
		expect(result.editable).toBe(false);
		expect(result.reason).toMatch(/read-only/);
	});

	test("a relation with no columns is an error, not an empty grid", async () => {
		await expect(
			readTablePage({
				session: fakeSession({ rows: [] }),
				dialect: POSTGRES_TABLE_DIALECT,
				catalog: catalogFor([]),
				request: {
					schema: "public",
					table: "ghost",
					kind: "table",
					limit: 100,
					offset: 0,
					sort: [],
					filter: "",
					count: false,
				},
				limits: LIMITS,
				readOnlyConnection: false,
			}),
		).rejects.toThrow(TableRequestError);
	});
});

describe("applyTableEdits", () => {
	const request = {
		schema: "public",
		table: "payments",
		edits: [
			{
				type: "update" as const,
				key: { id: { kind: "text" as const, text: "1" } },
				values: { amount: { kind: "text" as const, text: "5" } },
			},
		],
	};

	test("a single-row write is applied", async () => {
		const session = fakeSession({ affected: 1 });
		const outcome = await applyTableEdits({
			session,
			dialect: POSTGRES_TABLE_DIALECT,
			catalog: catalogFor(COLUMNS),
			request,
		});
		expect(outcome.applied).toBe(1);
	});

	test("a write that touched more than one row is refused", async () => {
		const session = fakeSession({ affected: 3 });
		await expect(
			applyTableEdits({
				session,
				dialect: POSTGRES_TABLE_DIALECT,
				catalog: catalogFor(COLUMNS),
				request,
			}),
		).rejects.toThrow(/matched 3 rows/);
	});

	test("a write that touched nothing is refused", async () => {
		const session = fakeSession({ affected: 0 });
		await expect(
			applyTableEdits({
				session,
				dialect: POSTGRES_TABLE_DIALECT,
				catalog: catalogFor(COLUMNS),
				request,
			}),
		).rejects.toThrow(/matched 0 rows/);
	});

	test("a table without a primary key cannot be written at all", async () => {
		const keyless = COLUMNS.map((column) => ({
			...column,
			primaryKey: false,
		}));
		await expect(
			applyTableEdits({
				session: fakeSession({ affected: 1 }),
				dialect: POSTGRES_TABLE_DIALECT,
				catalog: catalogFor(keyless),
				request,
			}),
		).rejects.toThrow(/no primary key/);
	});
});

describe("keyColumnsOf", () => {
	test("keeps ordinal order", () => {
		expect(keyColumnsOf(COLUMNS)).toEqual(["id"]);
	});
});
