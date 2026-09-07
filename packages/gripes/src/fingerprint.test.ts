import { describe, expect, test } from "bun:test";
import { normalizeStatement, statementFingerprint } from "./fingerprint";

/**
 * The occurrence-dismissal key (docs/spec/gripes.md "Dismissal"). What
 * matters is which edits keep a dismissal and which drop it.
 */

describe("normalizeStatement", () => {
	test("whitespace runs collapse and case folds", () => {
		expect(normalizeStatement("SELECT   *\n  FROM  t")).toBe("select * from t");
	});

	test("leading and trailing whitespace goes", () => {
		expect(normalizeStatement("  select 1  ")).toBe("select 1");
	});
});

describe("statementFingerprint", () => {
	test("the same statement always fingerprints the same", () => {
		expect(statementFingerprint("select * from a join b")).toBe(
			statementFingerprint("select * from a join b"),
		);
	});

	test("reformatting does not un-dismiss", () => {
		// Someone running the formatter should not have every dismissal
		// reappear.
		expect(statementFingerprint("select * from a join b")).toBe(
			statementFingerprint("SELECT *\n  FROM a\n  JOIN b"),
		);
	});

	test("changing the statement drops the dismissal", () => {
		// Correct: once the text changed, the finding may no longer hold,
		// so a stale dismissal must not keep hiding it.
		expect(statementFingerprint("select * from a join b")).not.toBe(
			statementFingerprint("select * from a join c"),
		);
	});

	test("editing a different statement is a different key", () => {
		expect(statementFingerprint("select 1")).not.toBe(
			statementFingerprint("select 2"),
		);
	});

	test("the key is short, printable and fixed width", () => {
		const key = statementFingerprint("select * from a join b");
		expect(key).toMatch(/^[0-9a-f]{8}$/);
	});

	test("an empty statement still produces a key", () => {
		expect(statementFingerprint("")).toMatch(/^[0-9a-f]{8}$/);
	});
});
