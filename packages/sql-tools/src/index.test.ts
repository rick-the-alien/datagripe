import { describe, expect, test } from "bun:test";
import { isRowReturningStatement, splitStatements, statementAt } from "./index";

describe("splitStatements", () => {
	test("splits on top-level semicolons", () => {
		const statements = splitStatements("select 1; select 2;\nselect 3");
		expect(statements.map((s) => s.text)).toEqual([
			"select 1",
			"select 2",
			"select 3",
		]);
	});

	test("tracks offsets", () => {
		const sql = "select 1;\n  select 2;";
		const [first, second] = splitStatements(sql);
		expect(first).toMatchObject({ start: 0, end: 8 });
		expect(second?.start).toBe(12);
		expect(sql.slice(first?.start ?? -1, first?.end ?? -1)).toBe("select 1");
		expect(sql.slice(second?.start ?? -1, second?.end ?? -1)).toBe("select 2");
	});

	test("semicolons inside strings do not split", () => {
		expect(
			splitStatements("select ';' as semi; select 2").map((s) => s.text),
		).toEqual(["select ';' as semi", "select 2"]);
	});

	test("escaped single quotes inside strings", () => {
		expect(
			splitStatements("select 'it''s; here'; select 2").map((s) => s.text),
		).toEqual(["select 'it''s; here'", "select 2"]);
	});

	test("E-strings honor backslash escapes", () => {
		expect(
			splitStatements(String.raw`select E'a\';b'; select 2`).map((s) => s.text),
		).toEqual([String.raw`select E'a\';b'`, "select 2"]);
	});

	test("semicolons inside quoted identifiers do not split", () => {
		expect(
			splitStatements('select 1 as "a;b"; select 2').map((s) => s.text),
		).toEqual(['select 1 as "a;b"', "select 2"]);
	});

	test("line comments are ignored for splitting and code detection", () => {
		expect(
			splitStatements(
				"-- comment; with semicolon\nselect 1; -- trailing\n",
			).map((s) => s.text),
		).toEqual(["select 1"]);
	});

	test("nested block comments", () => {
		expect(
			splitStatements("/* outer /* inner ; */ still comment ; */ select 1").map(
				(s) => s.text,
			),
		).toEqual(["select 1"]);
	});

	test("dollar-quoted bodies do not split", () => {
		const fn =
			"CREATE FUNCTION f() RETURNS void AS $body$ BEGIN RAISE NOTICE 'x;y'; END; $body$ LANGUAGE plpgsql";
		expect(splitStatements(`${fn}; select 2`).map((s) => s.text)).toEqual([
			fn,
			"select 2",
		]);
	});

	test("tagged dollar quotes only close on the matching tag", () => {
		expect(
			splitStatements("select $tag$a$b$c$tag$; select 2").map((s) => s.text),
		).toEqual(["select $tag$a$b$c$tag$", "select 2"]);
	});

	test("comment-only segments produce no statement", () => {
		expect(splitStatements("-- nothing\n/* nada */;").length).toBe(0);
		expect(splitStatements("   ;  ; ").length).toBe(0);
	});

	test("leading comments stay out of statement text", () => {
		const [statement] = splitStatements("-- lead\nselect 1");
		expect(statement?.text).toBe("select 1");
		expect(statement?.start).toBe(8);
	});

	test("unterminated constructs consume to the end without splitting", () => {
		expect(splitStatements("select 'oops; select 2").length).toBe(1);
		expect(splitStatements("select $q$abc; select 2").length).toBe(1);
	});
});

describe("statementAt", () => {
	const sql = "select 1;\nselect 22;\nselect 333;";

	test("finds the statement containing the offset", () => {
		expect(statementAt(sql, 0)?.text).toBe("select 1");
		expect(statementAt(sql, 3)?.text).toBe("select 1");
		expect(statementAt(sql, 12)?.text).toBe("select 22");
		expect(statementAt(sql, 24)?.text).toBe("select 333");
	});

	test("gaps resolve to the following statement", () => {
		expect(statementAt(sql, 9)?.text).toBe("select 22");
		expect(statementAt(sql, 20)?.text).toBe("select 333");
	});

	test("past the end resolves to the last statement", () => {
		expect(statementAt(sql, sql.length)?.text).toBe("select 333");
	});

	test("empty input returns null", () => {
		expect(statementAt("-- only a comment", 5)).toBeNull();
	});
});

describe("isRowReturningStatement", () => {
	test("select-like statements", () => {
		expect(isRowReturningStatement("select 1")).toBe(true);
		expect(isRowReturningStatement("  SELECT 1")).toBe(true);
		expect(
			isRowReturningStatement("with x as (select 1) select * from x"),
		).toBe(true);
		expect(isRowReturningStatement("values (1), (2)")).toBe(true);
		expect(isRowReturningStatement("-- c\nselect 1")).toBe(true);
	});

	test("non-select statements", () => {
		expect(isRowReturningStatement("insert into t values (1)")).toBe(false);
		expect(isRowReturningStatement("CREATE TABLE t (id int)")).toBe(false);
		expect(isRowReturningStatement("/* c */ update t set id = 1")).toBe(false);
	});
});
