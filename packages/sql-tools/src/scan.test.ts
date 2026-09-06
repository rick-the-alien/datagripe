import { describe, expect, test } from "bun:test";
import { scanTokens, splitOptionsForDialect } from "./index";

/** Tokens for static lint rules (docs/spec/gripes.md). */

function words(sql: string, dialect = "postgres"): string[] {
	return scanTokens(sql, splitOptionsForDialect(dialect))
		.filter((token) => token.kind === "word")
		.map((token) => token.text);
}

describe("scanTokens", () => {
	test("words are lower-cased and punctuation is separate", () => {
		expect(scanTokens("SELECT a, b FROM t").map((t) => t.text)).toEqual([
			"select",
			"a",
			",",
			"b",
			"from",
			"t",
		]);
	});

	test("a string literal is one token and its contents are not words", () => {
		// The whole point: a rule must not see `from` inside a literal.
		expect(words("select 'a from b' as x")).toEqual(["select", "as", "x"]);
		const literal = scanTokens("select 'a from b'").find(
			(token) => token.kind === "string",
		);
		expect(literal?.text).toBe("'a from b'");
	});

	test("doubled quotes inside a literal do not end it", () => {
		expect(words("select 'it''s from here' as x")).toEqual([
			"select",
			"as",
			"x",
		]);
	});

	test("comments are skipped entirely", () => {
		// A gripe about commented-out SQL is not a gripe.
		expect(words("select a -- from nowhere\nfrom t")).toEqual([
			"select",
			"a",
			"from",
			"t",
		]);
		expect(words("select /* from nowhere */ a from t")).toEqual([
			"select",
			"a",
			"from",
			"t",
		]);
	});

	test("nested block comments close at the right depth", () => {
		expect(words("select /* a /* b */ c */ d from t")).toEqual([
			"select",
			"d",
			"from",
			"t",
		]);
	});

	test("a quoted identifier is a word, unquoted, and flagged", () => {
		const tokens = scanTokens('select "From" from t');
		const quoted = tokens.find((token) => token.quoted);
		expect(quoted?.text).toBe("From");
		// Case is preserved for a quoted name, since it is a name.
		expect(quoted?.quoted).toBe(true);
	});

	test("backtick identifiers only apply to dialects that have them", () => {
		expect(words("select `from` from t", "mysql")).toEqual([
			"select",
			"from",
			"from",
			"t",
		]);
		const mysql = scanTokens(
			"select `from` from t",
			splitOptionsForDialect("mysql"),
		);
		expect(mysql[1]?.quoted).toBe(true);
	});

	test("a dollar-quoted body is one token", () => {
		const tokens = scanTokens("select $$ select * from nowhere $$ as body");
		expect(tokens.filter((t) => t.kind === "string")).toHaveLength(1);
		expect(words("select $$ select * from nowhere $$ as body")).toEqual([
			"select",
			"as",
			"body",
		]);
	});

	test("parenthesis depth is tracked, and parens report the outer depth", () => {
		const tokens = scanTokens("select (a + (b)) from t");
		const byText = (text: string) => tokens.find((t) => t.text === text);
		expect(byText("a")?.depth).toBe(1);
		expect(byText("b")?.depth).toBe(2);
		expect(byText("from")?.depth).toBe(0);
	});

	test("an unbalanced close paren does not drive depth negative", () => {
		const tokens = scanTokens("select a) from t");
		expect(tokens.every((token) => token.depth >= 0)).toBe(true);
		expect(words("select a) from t")).toEqual(["select", "a", "from", "t"]);
	});

	test("numbers are their own kind", () => {
		const tokens = scanTokens("select 41203882, 1.5 from t");
		expect(
			tokens.filter((t) => t.kind === "number").map((t) => t.text),
		).toEqual(["41203882", "1.5"]);
	});

	test("offsets point back at the original text", () => {
		const sql = "select amount from payments";
		const amount = scanTokens(sql).find((token) => token.text === "amount");
		expect(sql.slice(amount?.start, amount?.end)).toBe("amount");
	});

	test("an unterminated literal does not hang or leak words", () => {
		expect(words("select 'unterminated from t")).toEqual(["select"]);
	});
});
