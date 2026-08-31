import { describe, expect, test } from "bun:test";
import { splitOptionsForDialect, splitStatements } from "./index";

describe("dialect options", () => {
	test("mysql backslash escapes inside strings do not split", () => {
		const options = splitOptionsForDialect("mysql");
		expect(
			splitStatements(String.raw`select 'a\';b'; select 2`, options).map(
				(s) => s.text,
			),
		).toEqual([String.raw`select 'a\';b'`, "select 2"]);
	});

	test("mysql backtick identifiers do not split", () => {
		const options = splitOptionsForDialect("mysql");
		expect(
			splitStatements("select `a;b` from t; select 2", options).map(
				(s) => s.text,
			),
		).toEqual(["select `a;b` from t", "select 2"]);
	});

	test("backtick doubling escapes", () => {
		const options = splitOptionsForDialect("mysql");
		expect(
			splitStatements("select `a``;b` from t", options).map((s) => s.text),
		).toEqual(["select `a``;b` from t"]);
	});

	test("postgres dialect ignores backslashes and backticks", () => {
		const options = splitOptionsForDialect("postgres");
		// Backslash has no special meaning in plain postgres strings, so the
		// quote after it still terminates the string and the semicolon splits.
		expect(
			splitStatements(String.raw`select 'a\'; select 2`, options).length,
		).toBe(2);
		// Backtick is not a quote in postgres, so the semicolon splits.
		expect(splitStatements("select `a;b`", options).length).toBe(2);
	});

	test("sqlite allows backticks but not backslash escapes", () => {
		const options = splitOptionsForDialect("sqlite");
		expect(splitStatements("select `a;b` from t", options).length).toBe(1);
		expect(
			splitStatements(String.raw`select 'a\'; select 2`, options).length,
		).toBe(2);
	});
});
