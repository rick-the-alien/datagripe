import { describe, expect, test } from "bun:test";
import type { TableColumn } from "@datagripe/contracts";
import {
	assertNoUpdateDefaults,
	assertSingleExpression,
	deleteStatement,
	editabilityReason,
	insertStatement,
	MYSQL_TABLE_DIALECT,
	POSTGRES_TABLE_DIALECT,
	SQLITE_TABLE_DIALECT,
	selectCount,
	selectPage,
	TableRequestError,
	updateStatement,
	type WritableRelation,
} from "./builder";

function column(
	name: string,
	overrides: Partial<TableColumn> = {},
): TableColumn {
	return {
		name,
		dataType: "text",
		nullable: true,
		primaryKey: false,
		generated: false,
		hasDefault: false,
		...overrides,
	};
}

const COLUMNS: TableColumn[] = [
	column("id", { dataType: "integer", primaryKey: true, nullable: false }),
	column("amount", { dataType: "numeric" }),
	column("note"),
	column("total", { generated: true }),
];

const relation: WritableRelation = {
	schema: "public",
	table: "payments",
	columns: COLUMNS,
	keyColumns: ["id"],
};

describe("filter safety", () => {
	test("a plain predicate is accepted", () => {
		expect(() =>
			assertSingleExpression("amount > 100", POSTGRES_TABLE_DIALECT),
		).not.toThrow();
	});

	test("a semicolon inside a string literal is still one expression", () => {
		expect(() =>
			assertSingleExpression("note = 'a;b'", POSTGRES_TABLE_DIALECT),
		).not.toThrow();
	});

	test("stacked statements are rejected", () => {
		expect(() =>
			assertSingleExpression(
				"1=1; DROP TABLE payments",
				POSTGRES_TABLE_DIALECT,
			),
		).toThrow(TableRequestError);
	});

	test("a trailing semicolon is rejected", () => {
		expect(() =>
			assertSingleExpression("amount > 1;", POSTGRES_TABLE_DIALECT),
		).toThrow(TableRequestError);
	});

	test("mysql backtick identifiers do not fool the check", () => {
		expect(() =>
			assertSingleExpression("`a;b` = 1", MYSQL_TABLE_DIALECT),
		).not.toThrow();
	});
});

describe("select", () => {
	test("projects the known columns, quoted, with paging", () => {
		const query = selectPage(POSTGRES_TABLE_DIALECT, {
			schema: "public",
			table: "payments",
			columns: COLUMNS,
			sort: [],
			filter: "",
			limit: 100,
			offset: 200,
		});
		expect(query.sql).toBe(
			'SELECT "id", "amount", "note", "total" FROM "public"."payments" LIMIT 100 OFFSET 200',
		);
	});

	test("sort terms are quoted and ordered", () => {
		const query = selectPage(POSTGRES_TABLE_DIALECT, {
			schema: "public",
			table: "payments",
			columns: COLUMNS,
			sort: [
				{ column: "amount", direction: "desc" },
				{ column: "id", direction: "asc" },
			],
			filter: "",
			limit: 10,
			offset: 0,
		});
		expect(query.sql).toContain('ORDER BY "amount" DESC, "id" ASC');
	});

	test("an unknown sort column is rejected rather than emitted", () => {
		expect(() =>
			selectPage(POSTGRES_TABLE_DIALECT, {
				schema: "public",
				table: "payments",
				columns: COLUMNS,
				sort: [{ column: "amount) --", direction: "asc" }],
				filter: "",
				limit: 10,
				offset: 0,
			}),
		).toThrow(TableRequestError);
	});

	test("a quote in an identifier is doubled, not escaped away", () => {
		const query = selectPage(POSTGRES_TABLE_DIALECT, {
			schema: 'we"ird',
			table: 'ta"ble',
			columns: [column("a")],
			sort: [],
			filter: "",
			limit: 1,
			offset: 0,
		});
		expect(query.sql).toContain('FROM "we""ird"."ta""ble"');
	});

	test("count carries the same filter", () => {
		const query = selectCount(MYSQL_TABLE_DIALECT, {
			schema: "shop",
			table: "orders",
			filter: "status = 'paid'",
		});
		expect(query.sql).toBe(
			"SELECT count(*) AS dg_total FROM `shop`.`orders` WHERE status = 'paid'",
		);
	});
});

describe("update", () => {
	test("binds values and keys in placeholder order", () => {
		const query = updateStatement(POSTGRES_TABLE_DIALECT, relation, {
			key: { id: { kind: "text", text: "7" } },
			values: {
				note: { kind: "text", text: "hello" },
				amount: { kind: "null" },
			},
		});
		// Assignments follow ordinal order, so the SQL is stable.
		expect(query.sql).toBe(
			'UPDATE "public"."payments" SET "amount" = $1, "note" = $2 WHERE "id" = $3',
		);
		expect(query.params).toEqual([null, "hello", "7"]);
	});

	test("mysql placeholders are positional question marks", () => {
		const query = updateStatement(MYSQL_TABLE_DIALECT, relation, {
			key: { id: { kind: "text", text: "7" } },
			values: { note: { kind: "text", text: "x" } },
		});
		expect(query.sql).toBe(
			"UPDATE `public`.`payments` SET `note` = ? WHERE `id` = ?",
		);
		expect(query.params).toEqual(["x", "7"]);
	});

	test("a key that is not the primary key is refused", () => {
		expect(() =>
			updateStatement(POSTGRES_TABLE_DIALECT, relation, {
				key: { note: { kind: "text", text: "anything" } },
				values: { amount: { kind: "text", text: "1" } },
			}),
		).toThrow(/primary key/);
	});

	test("a partial composite key is refused", () => {
		const composite: WritableRelation = {
			...relation,
			keyColumns: ["id", "note"],
		};
		expect(() =>
			updateStatement(POSTGRES_TABLE_DIALECT, composite, {
				key: { id: { kind: "text", text: "1" } },
				values: { amount: { kind: "text", text: "1" } },
			}),
		).toThrow(/primary key/);
	});

	test("an unknown column cannot be written", () => {
		expect(() =>
			updateStatement(POSTGRES_TABLE_DIALECT, relation, {
				key: { id: { kind: "text", text: "1" } },
				values: { nope: { kind: "text", text: "1" } },
			}),
		).toThrow(/Unknown column/);
	});

	test("a generated column cannot be written", () => {
		expect(() =>
			updateStatement(POSTGRES_TABLE_DIALECT, relation, {
				key: { id: { kind: "text", text: "1" } },
				values: { total: { kind: "text", text: "1" } },
			}),
		).toThrow(/generated/);
	});

	test("a null key value becomes IS NULL rather than a bind", () => {
		const nullable: WritableRelation = { ...relation, keyColumns: ["note"] };
		const query = updateStatement(POSTGRES_TABLE_DIALECT, nullable, {
			key: { note: { kind: "null" } },
			values: { amount: { kind: "text", text: "2" } },
		});
		expect(query.sql).toContain('WHERE "note" IS NULL');
		expect(query.params).toEqual(["2"]);
	});
});

describe("insert", () => {
	test("omits columns left at their default", () => {
		const query = insertStatement(POSTGRES_TABLE_DIALECT, relation, {
			values: {
				id: { kind: "default" },
				amount: { kind: "text", text: "12.50" },
				note: { kind: "null" },
			},
		});
		expect(query.sql).toBe(
			'INSERT INTO "public"."payments" ("amount", "note") VALUES ($1, $2)',
		);
		expect(query.params).toEqual(["12.50", null]);
	});

	test("an all-defaults row uses each engine's spelling", () => {
		const values = { id: { kind: "default" } } as const;
		expect(
			insertStatement(POSTGRES_TABLE_DIALECT, relation, { values }).sql,
		).toBe('INSERT INTO "public"."payments" DEFAULT VALUES');
		expect(insertStatement(MYSQL_TABLE_DIALECT, relation, { values }).sql).toBe(
			"INSERT INTO `public`.`payments` () VALUES ()",
		);
		expect(
			insertStatement(SQLITE_TABLE_DIALECT, relation, { values }).sql,
		).toBe('INSERT INTO "public"."payments" DEFAULT VALUES');
	});
});

describe("delete", () => {
	test("addresses exactly the primary key", () => {
		const query = deleteStatement(POSTGRES_TABLE_DIALECT, relation, {
			key: { id: { kind: "text", text: "9" } },
		});
		expect(query.sql).toBe('DELETE FROM "public"."payments" WHERE "id" = $1');
		expect(query.params).toEqual(["9"]);
	});
});

describe("editability", () => {
	test("a read-only datasource is never editable", () => {
		expect(
			editabilityReason({ kind: "table", readOnly: true, keyColumns: ["id"] }),
		).toMatch(/read-only/);
	});

	test("a view is not editable", () => {
		expect(
			editabilityReason({ kind: "view", readOnly: false, keyColumns: ["id"] }),
		).toMatch(/Views/);
	});

	test("no primary key means no addressable row", () => {
		expect(
			editabilityReason({ kind: "table", readOnly: false, keyColumns: [] }),
		).toMatch(/primary key/);
	});

	test("a keyed writable table is editable", () => {
		expect(
			editabilityReason({ kind: "table", readOnly: false, keyColumns: ["id"] }),
		).toBeNull();
	});
});

describe("update defaults", () => {
	test("rejected where the engine has no portable spelling", () => {
		expect(() =>
			assertNoUpdateDefaults({ amount: { kind: "default" } }),
		).toThrow(TableRequestError);
		expect(() =>
			assertNoUpdateDefaults({ amount: { kind: "text", text: "1" } }),
		).not.toThrow();
	});
});
