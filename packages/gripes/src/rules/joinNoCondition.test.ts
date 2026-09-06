import { describe, expect, test } from "bun:test";
import type { SqlDialect } from "@datagripe/sql-tools";
import { MESSAGES } from "../messages";
import { renderFinding } from "../render";
import { statementInputFor } from "../statement";
import { joinNoCondition } from "./joinNoCondition";

/**
 * Per the spec, every rule gets three classes of fixture: one that
 * fires, one that does not, and one where the rule cannot tell and must
 * stay silent. This rule reads only the statement, so it can always
 * tell — the third class here is instead "constructs that look like the
 * finding and are not", which is where a wrong gripe would come from.
 */

function findings(sql: string, dialect: SqlDialect = "postgres") {
	return joinNoCondition.evaluate({
		statement: statementInputFor({
			documentId: "doc-1",
			dialect,
			text: sql,
		}),
	});
}

describe("join.no-condition — fires", () => {
	test("a bare join with no condition", () => {
		const found = findings("select * from a join b");
		expect(found).toHaveLength(1);
		expect(found[0]?.ruleId).toBe("join.no-condition");
		expect(found[0]?.severity).toBe("blocker");
	});

	test("an outer join with no condition", () => {
		expect(findings("select * from a left outer join b")).toHaveLength(1);
		expect(findings("select * from a full join b")).toHaveLength(1);
	});

	test("the condition-less join among several", () => {
		const found = findings(
			"select * from a join b on a.id = b.a_id join c where a.x = 1",
		);
		expect(found).toHaveLength(1);
	});

	test("one inside a subquery", () => {
		expect(
			findings("select * from (select * from a join b) t where t.x = 1"),
		).toHaveLength(1);
	});

	test("two of them are two findings", () => {
		expect(findings("select * from a join b join c")).toHaveLength(2);
	});

	test("the location points at the join keyword itself", () => {
		const sql = "select * from a join b";
		const found = findings(sql);
		const at = found[0]?.at;
		expect(at?.kind).toBe("document");
		if (at?.kind === "document") {
			expect(sql.slice(at.start, at.end)).toBe("join");
		}
	});

	test("the location is offset into the document, not the statement", () => {
		const statement = statementInputFor({
			documentId: "doc-1",
			dialect: "postgres",
			text: "select * from a join b",
			offset: 100,
		});
		const found = joinNoCondition.evaluate({ statement });
		const at = found[0]?.at;
		if (at?.kind === "document") {
			expect(at.start).toBe(100 + 16);
		}
	});
});

describe("join.no-condition — does not fire", () => {
	test("a join with ON", () => {
		expect(findings("select * from a join b on a.id = b.a_id")).toEqual([]);
	});

	test("a join with USING", () => {
		expect(findings("select * from a join b using (id)")).toEqual([]);
	});

	test("CROSS JOIN says cross product out loud", () => {
		// Firing here would be a wrong gripe, and a wrong gripe destroys
		// trust in every other gripe.
		expect(findings("select * from a cross join b")).toEqual([]);
	});

	test("NATURAL JOIN derives its condition from the column names", () => {
		expect(findings("select * from a natural join b")).toEqual([]);
		expect(findings("select * from a natural left join b")).toEqual([]);
	});

	test("CROSS JOIN LATERAL", () => {
		expect(findings("select * from a cross join lateral f(a.id) t")).toEqual(
			[],
		);
	});

	test("a nested join's condition does not satisfy the outer one", () => {
		// The ON here belongs to the inner join; the outer join is still
		// unconditioned and must be reported.
		const found = findings(
			"select * from a join (select * from b join c on b.id = c.b_id) t",
		);
		expect(found).toHaveLength(1);
	});

	test("no join at all", () => {
		expect(findings("select * from a where a.x = 1")).toEqual([]);
	});
});

describe("join.no-condition — looks like the finding and is not", () => {
	test("the word join inside a string literal", () => {
		expect(findings("select 'a join b' as note from t")).toEqual([]);
	});

	test("the word join in a comment", () => {
		expect(findings("select * from a -- join b\nwhere a.x = 1")).toEqual([]);
		expect(findings("select * from a /* join b */ where a.x = 1")).toEqual([]);
	});

	test("a quoted identifier called join", () => {
		// `"join"` is a column name, not a keyword.
		expect(findings('select "join" from t')).toEqual([]);
	});

	test("a mysql backtick identifier called join", () => {
		expect(findings("select `join` from t", "mysql")).toEqual([]);
	});

	test("a column whose name merely contains join", () => {
		expect(findings("select join_key from t")).toEqual([]);
		expect(findings("select * from joins where x = 1")).toEqual([]);
	});

	test("a join inside a dollar-quoted function body", () => {
		expect(
			findings("create function f() returns int as $$ select 1 join 2 $$"),
		).toEqual([]);
	});
});

describe("join.no-condition — wording", () => {
	test("renders at every attitude level with nothing left unresolved", () => {
		const found = findings("select * from a join b");
		const finding = found[0];
		if (finding === undefined) {
			throw new Error("expected a finding");
		}
		for (const level of ["notice", "warning", "fatal", "panic"] as const) {
			const text = renderFinding(finding, level, MESSAGES);
			expect(text.length).toBeGreaterThan(0);
			// A leftover {placeholder} in shipped UI is the failure this
			// catches.
			expect(text).not.toContain("{");
		}
	});

	test("the technical content survives every register", () => {
		const finding = findings("select * from a join b")[0];
		if (finding === undefined) {
			throw new Error("expected a finding");
		}
		for (const level of ["notice", "warning", "fatal", "panic"] as const) {
			expect(renderFinding(finding, level, MESSAGES).toLowerCase()).toContain(
				"join",
			);
		}
	});
});
