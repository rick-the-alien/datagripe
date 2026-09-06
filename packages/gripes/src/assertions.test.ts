import { describe, expect, test } from "bun:test";
import {
	assertEveryLevelPresent,
	assertIdsAreWellFormed,
	assertInputsDeclared,
	assertLengthCap,
	assertNoBarredTerms,
	assertNoOrphanWording,
	assertNoticeIsClean,
	checkCatalogue,
} from "./assertions";
import { RULES } from "./catalogue";
import { BARRED_TERMS, MESSAGES, SANCTIONED_PROFANITY } from "./messages";
import type { MessageCatalogue } from "./render";
import type { Rule } from "./types";

function rule(id: string, overrides: Partial<Rule> = {}): Rule {
	return {
		id,
		severity: "warning",
		inputs: ["statement"],
		evaluate: () => [],
		...overrides,
	};
}

function messages(text: string): MessageCatalogue[string] {
	return { notice: text, warning: text, fatal: text, panic: text };
}

describe("the shipped catalogue", () => {
	test("passes every mechanical check", () => {
		const { problems } = checkCatalogue(RULES, MESSAGES, {
			profanity: SANCTIONED_PROFANITY,
			barred: BARRED_TERMS,
		});
		expect(problems).toEqual([]);
	});

	test("every rule has wording and every wording has a rule", () => {
		expect(assertEveryLevelPresent(RULES, MESSAGES)).toEqual([]);
		expect(assertNoOrphanWording(RULES, MESSAGES)).toEqual([]);
	});
});

describe("assertEveryLevelPresent", () => {
	test("a missing level is a problem, not a fallback", () => {
		// Falling back to `warning` is how a level silently stops existing.
		const partial = {
			"a.b": {
				notice: "x",
				warning: "x",
				panic: "x",
			} as MessageCatalogue[string],
		};
		expect(assertEveryLevelPresent([rule("a.b")], partial)).toEqual([
			"a.b: no 'fatal' string",
		]);
	});

	test("a blank string counts as missing", () => {
		expect(
			assertEveryLevelPresent([rule("a.b")], {
				"a.b": { notice: "  ", warning: "x", fatal: "x", panic: "x" },
			}),
		).toEqual(["a.b: no 'notice' string"]);
	});

	test("a rule with no wording at all is reported once", () => {
		expect(assertEveryLevelPresent([rule("a.b")], {})).toEqual([
			"a.b: no wording at all",
		]);
	});
});

describe("assertLengthCap", () => {
	test("notice and warning are capped, fatal and panic are not", () => {
		const long = "x".repeat(91);
		const problems = assertLengthCap({
			"a.b": { notice: long, warning: "ok", fatal: long, panic: long },
		});
		expect(problems).toEqual(["a.b: 'notice' is 91 chars, cap is 90"]);
	});

	test("exactly at the cap is fine", () => {
		expect(assertLengthCap({ "a.b": messages("x".repeat(90)) })).toEqual([]);
	});
});

describe("assertNoticeIsClean", () => {
	test("profanity at notice is a problem", () => {
		expect(
			assertNoticeIsClean({ "a.b": messages("this is bloody slow") }, [
				"bloody",
			]),
		).toEqual(["a.b: 'notice' contains 'bloody'"]);
	});

	test("the same word at fatal is fine", () => {
		expect(
			assertNoticeIsClean(
				{
					"a.b": {
						notice: "this is slow",
						warning: "this is slow",
						fatal: "this is bloody slow",
						panic: "this is bloody slow",
					},
				},
				["bloody"],
			),
		).toEqual([]);
	});

	test("matching is on word boundaries, not substrings", () => {
		// "hello" must not match "hell", and "class" must not match a
		// three-letter word inside it. A substring check would be worse
		// than no check.
		expect(
			assertNoticeIsClean({ "a.b": messages("hello, shellfish") }, [
				"hell",
				"shell",
			]),
		).toEqual([]);
	});
});

describe("assertNoBarredTerms", () => {
	test("a barred term is caught at every level, panic included", () => {
		const problems = assertNoBarredTerms(
			{
				"a.b": {
					notice: "fine",
					warning: "fine",
					fatal: "fine",
					panic: "contains blockword here",
				},
			},
			["blockword"],
		);
		expect(problems).toEqual(["a.b: 'panic' contains a barred term"]);
	});

	test("the problem does not repeat the term back", () => {
		// The message goes in logs and CI output; echoing the term there
		// defeats the point of banning it.
		const problems = assertNoBarredTerms(
			{ "a.b": messages("contains blockword") },
			["blockword"],
		);
		expect(problems.every((problem) => !problem.includes("blockword"))).toBe(
			true,
		);
	});

	test("an empty list passes trivially, which is the known gap", () => {
		// BARRED_TERMS ships empty on purpose: choosing the terms is a
		// review step, not a guess. This test documents that the mechanism
		// works and the contents are outstanding.
		expect(assertNoBarredTerms({ "a.b": messages("anything") }, [])).toEqual(
			[],
		);
	});
});

describe("assertIdsAreWellFormed", () => {
	test("accepts <subject>.<problem> in lower-kebab", () => {
		expect(
			assertIdsAreWellFormed([
				rule("join.no-condition"),
				rule("index.missing"),
				rule("routine.volatile-but-readonly"),
			]),
		).toEqual([]);
	});

	test("rejects the shapes that would break greppability", () => {
		expect(assertIdsAreWellFormed([rule("JoinNoCondition")])).toHaveLength(1);
		expect(assertIdsAreWellFormed([rule("join")])).toHaveLength(1);
		expect(assertIdsAreWellFormed([rule("join.no_condition")])).toHaveLength(1);
		expect(assertIdsAreWellFormed([rule("join.a.b")])).toHaveLength(1);
	});

	test("a duplicate id is caught", () => {
		// Two rules sharing an id would share a dismissal, silencing one by
		// dismissing the other.
		expect(assertIdsAreWellFormed([rule("a.b"), rule("a.b")])).toContain(
			"a.b: duplicate id",
		);
	});
});

describe("assertInputsDeclared", () => {
	test("a rule with no inputs can never run", () => {
		expect(assertInputsDeclared([rule("a.b", { inputs: [] })])).toHaveLength(1);
	});
});

describe("assertNoOrphanWording", () => {
	test("wording for a rule that does not exist is dead weight", () => {
		expect(
			assertNoOrphanWording([rule("a.b")], {
				"a.b": messages("x"),
				"c.d": messages("x"),
			}),
		).toEqual(["c.d: wording for a rule that does not exist"]);
	});
});
