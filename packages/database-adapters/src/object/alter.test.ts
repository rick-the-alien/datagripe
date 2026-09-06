import { describe, expect, test } from "bun:test";
import type { ObjectColumn } from "@datagripe/contracts";
import {
	MYSQL_TABLE_DIALECT,
	POSTGRES_TABLE_DIALECT,
	SQLITE_TABLE_DIALECT,
	TableRequestError,
} from "../table/builder";
import {
	type AlterDialect,
	type AlterTarget,
	alterStatements,
	columnChangeStatements,
	MYSQL_ALTER,
	POSTGRES_ALTER,
	SQLITE_ALTER,
} from "./alter";

const PG: AlterDialect = { ...POSTGRES_TABLE_DIALECT, ...POSTGRES_ALTER };
const MY: AlterDialect = { ...MYSQL_TABLE_DIALECT, ...MYSQL_ALTER };
const LITE: AlterDialect = { ...SQLITE_TABLE_DIALECT, ...SQLITE_ALTER };

function column(
	name: string,
	overrides: Partial<ObjectColumn> = {},
): ObjectColumn {
	return {
		name,
		dataType: "text",
		nullable: true,
		defaultExpr: null,
		primaryKey: false,
		comment: null,
		...overrides,
	};
}

const target: AlterTarget = {
	schema: "shop",
	name: "orders",
	columns: [
		column("id", { dataType: "integer", nullable: false, primaryKey: true }),
		column("status", { defaultExpr: "'new'", comment: "Order state" }),
		column("amount", { dataType: "numeric(10,2)", nullable: false }),
	],
};

describe("add column", () => {
	test("postgres renders type, nullability and default", () => {
		expect(
			columnChangeStatements(PG, target, {
				type: "add",
				name: "note",
				dataType: "text",
				nullable: false,
				defaultExpr: "''",
				comment: null,
			}),
		).toEqual([
			`ALTER TABLE "shop"."orders" ADD COLUMN "note" text NOT NULL DEFAULT '';`,
		]);
	});

	test("a comment is its own statement on postgres", () => {
		expect(
			columnChangeStatements(PG, target, {
				type: "add",
				name: "note",
				dataType: "text",
				nullable: true,
				defaultExpr: null,
				comment: "Free text",
			}),
		).toEqual([
			`ALTER TABLE "shop"."orders" ADD COLUMN "note" text;`,
			`COMMENT ON COLUMN "shop"."orders"."note" IS 'Free text';`,
		]);
	});

	test("a comment is inline on mysql", () => {
		expect(
			columnChangeStatements(MY, target, {
				type: "add",
				name: "note",
				dataType: "varchar(64)",
				nullable: true,
				defaultExpr: null,
				comment: "Free text",
			}),
		).toEqual([
			"ALTER TABLE `shop`.`orders` ADD COLUMN `note` varchar(64) COMMENT 'Free text';",
		]);
	});

	test("a quote in a comment is escaped, not passed through", () => {
		const [statement] = columnChangeStatements(PG, target, {
			type: "add",
			name: "note",
			dataType: "text",
			nullable: true,
			defaultExpr: null,
			comment: "it's here",
		}).slice(1);
		expect(statement).toContain("IS 'it''s here'");
	});
});

describe("rename column", () => {
	test("all three engines use RENAME COLUMN", () => {
		const change = {
			type: "rename" as const,
			name: "status",
			newName: "state",
		};
		expect(columnChangeStatements(PG, target, change)).toEqual([
			`ALTER TABLE "shop"."orders" RENAME COLUMN "status" TO "state";`,
		]);
		expect(columnChangeStatements(LITE, target, change)).toEqual([
			`ALTER TABLE "shop"."orders" RENAME COLUMN "status" TO "state";`,
		]);
		expect(columnChangeStatements(MY, target, change)).toEqual([
			"ALTER TABLE `shop`.`orders` RENAME COLUMN `status` TO `state`;",
		]);
	});

	test("renaming a column that is not there is refused", () => {
		expect(() =>
			columnChangeStatements(PG, target, {
				type: "rename",
				name: "nope",
				newName: "x",
			}),
		).toThrow(/Unknown column/);
	});
});

describe("type, nullability and default", () => {
	test("postgres alters one attribute at a time", () => {
		expect(
			columnChangeStatements(PG, target, {
				type: "setType",
				name: "status",
				dataType: "varchar(32)",
			}),
		).toEqual([
			`ALTER TABLE "shop"."orders" ALTER COLUMN "status" TYPE varchar(32) USING "status"::varchar(32);`,
		]);
		expect(
			columnChangeStatements(PG, target, {
				type: "setNullable",
				name: "amount",
				nullable: true,
			}),
		).toEqual([
			`ALTER TABLE "shop"."orders" ALTER COLUMN "amount" DROP NOT NULL;`,
		]);
		expect(
			columnChangeStatements(PG, target, {
				type: "setDefault",
				name: "status",
				defaultExpr: null,
			}),
		).toEqual([
			`ALTER TABLE "shop"."orders" ALTER COLUMN "status" DROP DEFAULT;`,
		]);
	});

	test("mysql restates the whole definition and keeps the rest", () => {
		// `status` is nullable with a default and a comment; changing only
		// the type must not silently drop the other three.
		expect(
			columnChangeStatements(MY, target, {
				type: "setType",
				name: "status",
				dataType: "varchar(32)",
			}),
		).toEqual([
			"ALTER TABLE `shop`.`orders` MODIFY COLUMN `status` varchar(32) NULL DEFAULT 'new' COMMENT 'Order state';",
		]);
	});

	test("mysql dropping a default keeps type, nullability and comment", () => {
		expect(
			columnChangeStatements(MY, target, {
				type: "setDefault",
				name: "status",
				defaultExpr: null,
			}),
		).toEqual([
			"ALTER TABLE `shop`.`orders` MODIFY COLUMN `status` text NULL COMMENT 'Order state';",
		]);
	});

	test("an empty default string means drop, not empty literal", () => {
		expect(
			columnChangeStatements(PG, target, {
				type: "setDefault",
				name: "status",
				defaultExpr: "   ",
			}),
		).toEqual([
			`ALTER TABLE "shop"."orders" ALTER COLUMN "status" DROP DEFAULT;`,
		]);
	});

	test("a default that stacks statements is refused", () => {
		expect(() =>
			columnChangeStatements(PG, target, {
				type: "setDefault",
				name: "status",
				defaultExpr: "'x'; DROP TABLE shop.orders",
			}),
		).toThrow(TableRequestError);
	});

	test("a default containing a semicolon in a literal is allowed", () => {
		expect(
			columnChangeStatements(PG, target, {
				type: "setDefault",
				name: "status",
				defaultExpr: "'a;b'",
			})[0],
		).toContain("SET DEFAULT 'a;b'");
	});
});

describe("comments", () => {
	test("postgres uses COMMENT ON, and null clears it", () => {
		expect(
			columnChangeStatements(PG, target, {
				type: "setComment",
				name: "status",
				comment: null,
			}),
		).toEqual([`COMMENT ON COLUMN "shop"."orders"."status" IS NULL;`]);
	});
});

describe("drop column", () => {
	test("renders a plain DROP COLUMN", () => {
		expect(
			columnChangeStatements(PG, target, { type: "drop", name: "status" }),
		).toEqual([`ALTER TABLE "shop"."orders" DROP COLUMN "status";`]);
	});
});

describe("sqlite limits", () => {
	test("add, rename and drop work", () => {
		expect(
			columnChangeStatements(LITE, target, {
				type: "add",
				name: "note",
				dataType: "TEXT",
				nullable: true,
				defaultExpr: null,
				comment: null,
			}),
		).toEqual([`ALTER TABLE "shop"."orders" ADD COLUMN "note" TEXT;`]);
		expect(
			columnChangeStatements(LITE, target, { type: "drop", name: "status" }),
		).toEqual([`ALTER TABLE "shop"."orders" DROP COLUMN "status";`]);
	});

	test("a type change is refused by name, with the reason", () => {
		expect(() =>
			columnChangeStatements(LITE, target, {
				type: "setType",
				name: "status",
				dataType: "INTEGER",
			}),
		).toThrow(/needs the table rebuilt/);
	});

	test("nullability and defaults are refused too", () => {
		expect(() =>
			columnChangeStatements(LITE, target, {
				type: "setNullable",
				name: "status",
				nullable: false,
			}),
		).toThrow(/not available/);
		expect(() =>
			columnChangeStatements(LITE, target, {
				type: "setDefault",
				name: "status",
				defaultExpr: "'x'",
			}),
		).toThrow(/not available/);
	});
});

describe("batches", () => {
	test("statements come out in the order given", () => {
		expect(
			alterStatements(PG, target, [
				{
					type: "add",
					name: "note",
					dataType: "text",
					nullable: true,
					defaultExpr: null,
					comment: null,
				},
				{ type: "drop", name: "status" },
			]),
		).toEqual([
			`ALTER TABLE "shop"."orders" ADD COLUMN "note" text;`,
			`ALTER TABLE "shop"."orders" DROP COLUMN "status";`,
		]);
	});

	test("touching a column again after renaming it is refused", () => {
		// The old name no longer exists, so the second statement would fail
		// on the server; saying so up front is better than half a batch.
		expect(() =>
			alterStatements(PG, target, [
				{ type: "rename", name: "status", newName: "state" },
				{ type: "setDefault", name: "status", defaultExpr: "'x'" },
			]),
		).toThrow(/renamed earlier in this batch/);
	});
});
