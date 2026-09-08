import { describe, expect, test } from "bun:test";
import { formatSql } from "./index";

/** The editor's reformat command (docs/spec/editor-workspace.md). */

describe("formatSql", () => {
	test("one clause per line, keywords upper-cased", () => {
		expect(
			formatSql("select id, name from users u where u.status = 'active'"),
		).toBe(
			["SELECT id, name", "FROM users u", "WHERE u.status = 'active'"].join(
				"\n",
			),
		);
	});

	test("identifiers, literals and quoted names keep their case", () => {
		// SQL folds unquoted names, so only a formatter that leaves them
		// alone is safe: `"From"` and `'From'` are data, not keywords.
		expect(formatSql(`select "From", 'From' as From_ from "T"`)).toBe(
			["SELECT \"From\", 'From' AS From_", 'FROM "T"'].join("\n"),
		);
	});

	test("a select list breaks one item per line once it is too wide", () => {
		expect(
			formatSql("select alpha, beta, gamma from t", { maxWidth: 20 }),
		).toBe(
			["SELECT", "    alpha,", "    beta,", "    gamma", "FROM t"].join("\n"),
		);
	});

	test("predicates break before AND/OR, at the start of the line", () => {
		expect(
			formatSql("select a from t where x = 1 and y = 2", { maxWidth: 20 }),
		).toBe(
			["SELECT a", "FROM t", "WHERE", "    x = 1", "    AND y = 2"].join("\n"),
		);
	});

	test("BETWEEN's own AND is part of the operator, not a break", () => {
		expect(
			formatSql("select a from t where x between 1 and 9", { maxWidth: 20 }),
		).toBe(["SELECT a", "FROM t", "WHERE x BETWEEN 1 AND 9"].join("\n"));
	});

	test("joins hang under the FROM they qualify, ON stays with them", () => {
		expect(
			formatSql("select 1 from a left join b on b.id = a.id and b.ok"),
		).toBe(
			["SELECT 1", "FROM a", "    LEFT JOIN b ON b.id = a.id AND b.ok"].join(
				"\n",
			),
		);
	});

	test("a subquery stays inline while it fits and breaks when it does not", () => {
		expect(formatSql("select 1 from t where id in (select id from vip)")).toBe(
			["SELECT 1", "FROM t", "WHERE id IN (SELECT id FROM vip)"].join("\n"),
		);
		expect(
			formatSql("select 1 from (select id from vip) v", { maxWidth: 20 }),
		).toBe(
			["SELECT 1", "FROM (", "    SELECT id", "    FROM vip", ") v"].join("\n"),
		);
	});

	test("a DDL column list is a list, not a function call", () => {
		expect(
			formatSql(
				"create table t (id bigserial primary key, email text not null)",
				{ maxWidth: 40 },
			),
		).toBe(
			[
				"CREATE TABLE t (",
				"    id bigserial PRIMARY KEY,",
				"    email text NOT NULL",
				")",
			].join("\n"),
		);
		// A paren after a plain name is still a call: `count(*)`, `f(x)`.
		expect(formatSql("select count(*), f(x) from t")).toBe(
			["SELECT count(*), f(x)", "FROM t"].join("\n"),
		);
	});

	test("a CASE that does not fit breaks per branch, END back at its own level", () => {
		expect(
			formatSql("select case when a then 1 else 2 end as x from t", {
				maxWidth: 24,
			}),
		).toBe(
			[
				"SELECT CASE",
				"    WHEN a THEN 1",
				"    ELSE 2",
				"END AS x",
				"FROM t",
			].join("\n"),
		);
	});

	test("GRANT keeps its whole statement on one line", () => {
		// Its SELECT is a privilege, not a query to hang under the GRANT.
		expect(formatSql("grant select, insert on table t to app")).toBe(
			"GRANT SELECT, INSERT ON TABLE t TO app",
		);
	});

	test("statements keep their semicolons and the blank line between them", () => {
		expect(formatSql("select 1;\n\nselect 2;")).toBe(
			["SELECT 1;", "", "SELECT 2;"].join("\n"),
		);
		expect(formatSql("select 1;\nselect 2;")).toBe(
			["SELECT 1;", "SELECT 2;"].join("\n"),
		);
		// No semicolon in, no semicolon out.
		expect(formatSql("select 1")).toBe("SELECT 1");
	});

	test("a blank line between clauses is a paragraph break, and survives", () => {
		expect(formatSql("select a\n\nfrom t\nwhere x = 1")).toBe(
			["SELECT a", "", "FROM t", "WHERE x = 1"].join("\n"),
		);
	});

	test("comments stay on the side of the code they were written for", () => {
		expect(formatSql("-- header\nselect 1; -- trailing\nselect 2;")).toBe(
			["-- header", "SELECT 1; -- trailing", "SELECT 2;"].join("\n"),
		);
		// A comment inside a list keeps its line, and the comma lands
		// before it — a comma after it would be commented out.
		expect(formatSql("select a, -- why\n b from t")).toBe(
			["SELECT", "    a, -- why", "    b", "FROM t"].join("\n"),
		);
		expect(formatSql("select /* inline */ 1 from t")).toBe(
			["SELECT /* inline */ 1", "FROM t"].join("\n"),
		);
	});

	test("a multi-line literal is copied verbatim and does not break its line", () => {
		expect(
			formatSql(
				"create function f(x int) as $b$\n  select x;\n$b$ language sql",
			),
		).toBe("CREATE FUNCTION f(x int) AS $b$\n  select x;\n$b$ language sql");
	});

	test("dialect quoting: backticked names survive", () => {
		expect(
			formatSql("select `odd name` from t where s = 'a\\'b'", {
				dialect: "mysql",
			}),
		).toBe(["SELECT `odd name`", "FROM t", "WHERE s = 'a\\'b'"].join("\n"));
	});

	test("indent and keyword case are the caller's choice", () => {
		expect(
			formatSql("select alpha, beta from t", {
				indent: "\t",
				maxWidth: 16,
				keywordCase: "preserve",
			}),
		).toBe(["select", "\talpha,", "\tbeta", "from t"].join("\n"));
	});

	test("formatting is idempotent", () => {
		const sql =
			"select u.id, count(*) c from users u join orders o on o.uid = u.id where u.ok and o.total > 10 group by u.id having count(*) > 2 order by c desc limit 5;";
		const once = formatSql(sql);
		expect(formatSql(once)).toBe(once);
	});

	test("a trailing newline is kept, and empty input is returned as-is", () => {
		expect(formatSql("select 1\n")).toBe("SELECT 1\n");
		expect(formatSql("")).toBe("");
		expect(formatSql("   \n  ")).toBe("   \n  ");
	});

	test("input the walker cannot lay out comes back untouched", () => {
		// The round trip is the guard: half-typed SQL keeps its own text
		// rather than being rearranged into something else.
		expect(formatSql("select a from (t")).toBe("select a from (t");
		// A stray comma is not lost either: it survives as it was typed.
		expect(formatSql("select a,   from t")).toBe("SELECT a,\nFROM t");
		expect(formatSql(")")).toBe(")");
	});
});
