import { describe, expect, test } from "bun:test";
import { findingsFor } from "./fixtures";
import { deleteNoWhere, updateNoWhere } from "./unqualifiedWrite";

/** `delete.no-where` and `update.no-where` (docs/spec/gripes.md). */

describe("delete.no-where — fires", () => {
	test("a bare delete", () => {
		const found = findingsFor(deleteNoWhere, "delete from payments");
		expect(found).toHaveLength(1);
		expect(found[0]?.severity).toBe("blocker");
	});

	test("a delete with only RETURNING", () => {
		expect(
			findingsFor(deleteNoWhere, "delete from payments returning id"),
		).toHaveLength(1);
	});

	test("a delete whose only WHERE is inside a subquery", () => {
		// The subquery's WHERE narrows the subquery, not the delete: this
		// still removes every row.
		expect(
			findingsFor(
				deleteNoWhere,
				"delete from payments using (select id from users where id = 1) u",
			),
		).toHaveLength(1);
	});

	test("the location points at the verb", () => {
		const sql = "delete from payments";
		const at = findingsFor(deleteNoWhere, sql)[0]?.at;
		if (at?.kind === "document") {
			expect(sql.slice(at.start, at.end)).toBe("delete");
		}
	});
});

describe("delete.no-where — does not fire", () => {
	test("a delete with a where clause", () => {
		expect(
			findingsFor(deleteNoWhere, "delete from payments where id = 1"),
		).toEqual([]);
	});

	test("a select, an update, or a truncate", () => {
		expect(findingsFor(deleteNoWhere, "select * from payments")).toEqual([]);
		expect(findingsFor(deleteNoWhere, "update payments set a = 1")).toEqual([]);
		expect(findingsFor(deleteNoWhere, "truncate payments")).toEqual([]);
	});

	test("a CTE that ends in a qualified delete", () => {
		expect(
			findingsFor(
				deleteNoWhere,
				"with stale as (select id from payments) delete from payments where id in (select id from stale)",
			),
		).toEqual([]);
	});

	test("a CTE ending in an unqualified delete still fires", () => {
		expect(
			findingsFor(
				deleteNoWhere,
				"with stale as (select id from payments) delete from payments",
			),
		).toHaveLength(1);
	});
});

describe("delete.no-where — looks like the finding and is not", () => {
	test("a trigger definition naming delete as an event", () => {
		// The verb is `create`; the `delete` is an event name, and a trigger
		// has no WHERE. Firing here would gripe at every trigger in the
		// database.
		expect(
			findingsFor(
				deleteNoWhere,
				"create trigger t after delete on payments for each row execute function f()",
			),
		).toEqual([]);
	});

	test("a grant of the delete privilege", () => {
		expect(
			findingsFor(deleteNoWhere, "grant delete on payments to app_rw"),
		).toEqual([]);
	});

	test("the word delete in a string or a comment", () => {
		expect(findingsFor(deleteNoWhere, "select 'delete from x' as t")).toEqual(
			[],
		);
		expect(
			findingsFor(deleteNoWhere, "select 1 -- delete from payments"),
		).toEqual([]);
	});

	test("a column named delete", () => {
		expect(findingsFor(deleteNoWhere, 'select "delete" from t')).toEqual([]);
	});
});

describe("update.no-where", () => {
	test("fires on a bare update", () => {
		expect(
			findingsFor(updateNoWhere, "update payments set status = 'void'"),
		).toHaveLength(1);
	});

	test("does not fire when qualified", () => {
		expect(
			findingsFor(
				updateNoWhere,
				"update payments set status = 'void' where id = 1",
			),
		).toEqual([]);
	});

	test("an UPDATE ... FROM without a WHERE is still every row", () => {
		expect(
			findingsFor(
				updateNoWhere,
				"update payments set status = u.status from users u",
			),
		).toHaveLength(1);
	});

	test("a trigger naming update as an event does not fire", () => {
		expect(
			findingsFor(
				updateNoWhere,
				"create trigger t before update on payments for each row execute function f()",
			),
		).toEqual([]);
	});

	test("the two rules do not fire on each other's statements", () => {
		expect(findingsFor(updateNoWhere, "delete from payments")).toEqual([]);
		expect(findingsFor(deleteNoWhere, "update payments set a = 1")).toEqual([]);
	});
});
