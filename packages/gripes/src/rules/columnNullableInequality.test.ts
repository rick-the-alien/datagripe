import { describe, expect, test } from "bun:test";
import { columnNullableInequality } from "./columnNullableInequality";
import { schemaFindingsFor, schemaFor, statementFor } from "./fixtures";

/** `column.nullable-inequality` (docs/spec/gripes.md). */

const nullableStatus = schemaFor({
	nullable: { ".orders.status": true, ".orders.id": false },
});

function found(sql: string, schema = nullableStatus) {
	return schemaFindingsFor(columnNullableInequality, sql, schema);
}

describe("fires", () => {
	test("a <> against a nullable column", () => {
		const findings = found("select * from orders where status <> 'void'");
		expect(findings).toHaveLength(1);
		expect(findings[0]?.facts).toEqual({ column: "status" });
	});

	test("the != spelling too", () => {
		// `!` was not tokenized at all before, so this used to read as `=`.
		expect(found("select * from orders where status != 'void'")).toHaveLength(
			1,
		);
	});

	test("through an alias", () => {
		expect(
			found("select * from orders o where o.status <> 'void'"),
		).toHaveLength(1);
	});

	test("through a schema-qualified table", () => {
		const schema = schemaFor({ nullable: { "shop.orders.status": true } });
		expect(
			found("select * from shop.orders where status <> 'void'", schema),
		).toHaveLength(1);
	});

	test("the location covers the column and the operator", () => {
		const sql = "select * from orders where status <> 'void'";
		const at = found(sql)[0]?.at;
		if (at?.kind === "document") {
			expect(sql.slice(at.start, at.end)).toBe("status <>");
		}
	});
});

describe("does not fire", () => {
	test("on a column the schema says is not nullable", () => {
		expect(found("select * from orders where id <> 1")).toEqual([]);
	});

	test("on equality, which everyone reads correctly", () => {
		// Most columns are nullable; griping here would fire on half the
		// queries in the tool.
		expect(found("select * from orders where status = 'void'")).toEqual([]);
	});

	test("on is distinct from, which is the fix", () => {
		expect(
			found("select * from orders where status is distinct from 'void'"),
		).toEqual([]);
	});
});

describe("cannot tell, so stays silent", () => {
	test("when the schema does not know the column", () => {
		expect(found("select * from orders where notes <> 'x'")).toEqual([]);
	});

	test("when either input is missing", () => {
		expect(
			columnNullableInequality.evaluate({ schema: nullableStatus }),
		).toEqual([]);
		expect(
			columnNullableInequality.evaluate({
				statement: statementFor("select * from orders where status <> 'void'"),
			}),
		).toEqual([]);
	});

	test("when a bare column could come from either of two tables", () => {
		// Asking the schema about the wrong table would be worse than
		// saying nothing.
		const schema = schemaFor({
			nullable: { ".orders.status": true, ".shipments.status": false },
		});
		expect(
			found(
				"select * from orders join shipments on shipments.order_id = orders.id where status <> 'void'",
				schema,
			),
		).toEqual([]);
	});

	test("when the qualifier is not a table in scope", () => {
		expect(found("select * from orders where x.status <> 'void'")).toEqual([]);
	});

	test("when the predicate is inside a subquery", () => {
		// Its scope holds tables `tablesInScope` never saw.
		expect(
			found(
				"select * from orders where id in (select id from orders where status <> 'void')",
			),
		).toEqual([]);
	});

	test("when the left operand is a function call", () => {
		// An expression index may well cover it, and the schema is not
		// being asked about a plain column any more.
		expect(
			found("select * from orders where coalesce(status) <> 'void'"),
		).toEqual([]);
	});

	test("when the right operand is another column", () => {
		// Comparing two columns is a different question, with two
		// nullabilities in play.
		expect(found("select * from orders where status <> id")).toEqual([]);
	});
});
