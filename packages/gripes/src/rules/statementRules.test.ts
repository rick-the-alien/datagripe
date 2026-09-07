import { describe, expect, test } from "bun:test";
import { findingsFor } from "./fixtures";
import { indexNotConcurrent } from "./indexNotConcurrent";
import { subqueryNotIn } from "./subqueryNotIn";
import { viewSelectStar } from "./viewSelectStar";

/**
 * `subquery.not-in`, `view.select-star` and `index.not-concurrent`
 * (docs/spec/gripes.md).
 */

describe("subquery.not-in", () => {
	test("fires on not in against a subquery", () => {
		const found = findingsFor(
			subqueryNotIn,
			"select * from users where id not in (select user_id from bans)",
		);
		expect(found).toHaveLength(1);
		expect(found[0]?.severity).toBe("warning");
	});

	test("fires when the subquery leads with a CTE", () => {
		expect(
			findingsFor(
				subqueryNotIn,
				"select * from users where id not in (with b as (select 1 as u) select u from b)",
			),
		).toHaveLength(1);
	});

	test("the location covers both words", () => {
		const sql =
			"select * from users where id not in (select user_id from bans)";
		const at = findingsFor(subqueryNotIn, sql)[0]?.at;
		if (at?.kind === "document") {
			expect(sql.slice(at.start, at.end)).toBe("not in");
		}
	});

	test("does not fire on a literal list", () => {
		// A null in a written-out list is visible to whoever reads it.
		expect(
			findingsFor(
				subqueryNotIn,
				"select * from users where id not in (1, 2, 3)",
			),
		).toEqual([]);
	});

	test("does not fire on a positive in", () => {
		// A null there simply fails to match, which is what a reader expects.
		expect(
			findingsFor(
				subqueryNotIn,
				"select * from users where id in (select user_id from bans)",
			),
		).toEqual([]);
	});

	test("does not fire on not exists, which is the fix", () => {
		expect(
			findingsFor(
				subqueryNotIn,
				"select * from users u where not exists (select 1 from bans where user_id = u.id)",
			),
		).toEqual([]);
	});

	test("does not fire on a values list", () => {
		expect(
			findingsFor(
				subqueryNotIn,
				"select * from users where id not in (values (1), (2))",
			),
		).toEqual([]);
	});

	describe("looks like the finding and is not", () => {
		test("not null, not like and not between", () => {
			for (const sql of [
				"select * from users where id is not null",
				"select * from users where name not like 'a%'",
				"select * from users where id not between 1 and 9",
			]) {
				expect(findingsFor(subqueryNotIn, sql)).toEqual([]);
			}
		});

		test("the words in a string or a comment", () => {
			expect(
				findingsFor(subqueryNotIn, "select 'not in (select 1)' as t"),
			).toEqual([]);
			expect(
				findingsFor(subqueryNotIn, "select 1 -- not in (select x from y)"),
			).toEqual([]);
		});
	});
});

describe("view.select-star", () => {
	test("fires on a view defined with a star", () => {
		const found = findingsFor(
			viewSelectStar,
			"create view v as select * from orders",
		);
		expect(found).toHaveLength(1);
	});

	test("fires on or replace and on materialized", () => {
		for (const sql of [
			"create or replace view v as select * from orders",
			"create materialized view v as select * from orders",
		]) {
			expect(findingsFor(viewSelectStar, sql)).toHaveLength(1);
		}
	});

	test("fires on a qualified star", () => {
		expect(
			findingsFor(
				viewSelectStar,
				"create view v as select o.* from orders o join users u on u.id = o.user_id",
			),
		).toHaveLength(1);
	});

	test("does not fire on an explicit column list", () => {
		expect(
			findingsFor(
				viewSelectStar,
				"create view v as select id, total from orders",
			),
		).toEqual([]);
	});

	test("does not fire on a plain select outside a view", () => {
		// A star in an ad-hoc query is a different finding with a different
		// cost; this rule is only about the freezing.
		expect(findingsFor(viewSelectStar, "select * from orders")).toEqual([]);
	});

	describe("looks like the finding and is not", () => {
		test("multiplication in the projection", () => {
			// `a * 2` is a `*` punct token at the same depth as a real star.
			expect(
				findingsFor(
					viewSelectStar,
					"create view v as select qty * price as total from lines",
				),
			).toEqual([]);
		});

		test("count(*), which names no columns to freeze", () => {
			expect(
				findingsFor(
					viewSelectStar,
					"create view v as select count(*) as n from orders",
				),
			).toEqual([]);
		});

		test("a table with a column named view", () => {
			expect(
				findingsFor(viewSelectStar, 'create table t ("view" text, a int)'),
			).toEqual([]);
		});
	});
});

describe("index.not-concurrent", () => {
	test("fires on create index with no concurrently", () => {
		const found = findingsFor(
			indexNotConcurrent,
			"create index idx_orders_user on orders (user_id)",
		);
		expect(found).toHaveLength(1);
		expect(found[0]?.severity).toBe("warning");
	});

	test("fires on a unique index too", () => {
		expect(
			findingsFor(
				indexNotConcurrent,
				"create unique index idx_orders_ref on orders (ref)",
			),
		).toHaveLength(1);
	});

	test("does not fire with concurrently", () => {
		expect(
			findingsFor(
				indexNotConcurrent,
				"create index concurrently idx_orders_user on orders (user_id)",
			),
		).toEqual([]);
	});

	test("does not fire on drop index or on create table", () => {
		expect(
			findingsFor(indexNotConcurrent, "drop index idx_orders_user"),
		).toEqual([]);
		expect(findingsFor(indexNotConcurrent, "create table t (a int)")).toEqual(
			[],
		);
	});

	describe("looks like the finding and is not", () => {
		test("a dialect where the advice would be wrong", () => {
			// MySQL manages this with its own algorithm options and SQLite has
			// no equivalent, so `concurrently` is not merely unhelpful advice
			// there — it is a syntax error.
			for (const dialect of ["mysql", "sqlite"] as const) {
				expect(
					findingsFor(
						indexNotConcurrent,
						"create index idx_orders_user on orders (user_id)",
						dialect,
					),
				).toEqual([]);
			}
		});

		test("a table with a column named index", () => {
			expect(
				findingsFor(indexNotConcurrent, 'create table t ("index" int)'),
			).toEqual([]);
		});
	});
});
