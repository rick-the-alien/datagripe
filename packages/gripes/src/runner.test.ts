import { describe, expect, test } from "bun:test";
import type { Finding } from "@datagripe/contracts";
import { rulesFor, runRules, sortFindings } from "./runner";
import { statementInputFor } from "./statement";
import type { GripeContext, Rule } from "./types";

function fires(id: string, overrides: Partial<Rule> = {}): Rule {
	return {
		id,
		severity: "warning",
		inputs: ["statement"],
		evaluate: () => [
			{
				ruleId: id,
				severity: overrides.severity ?? "warning",
				at: { kind: "document", documentId: "doc-1", start: 0, end: 1 },
				facts: {},
			},
		],
		...overrides,
	};
}

const statement = statementInputFor({
	documentId: "doc-1",
	dialect: "postgres",
	text: "select 1",
});

describe("rulesFor", () => {
	test("only rules whose inputs are all available", () => {
		const rules = [
			fires("a.statement", { inputs: ["statement"] }),
			fires("b.execution", { inputs: ["execution"] }),
			fires("c.both", { inputs: ["statement", "execution"] }),
		];
		// A client has the statement but no execution outcome.
		expect(rulesFor(rules, { statement }).map((rule) => rule.id)).toEqual([
			"a.statement",
		]);
	});

	test("a rule needing two inputs runs when both are there", () => {
		const context: GripeContext = {
			statement,
			execution: {
				executionId: "e-1",
				rowCount: 10,
				elapsedMs: 5,
				truncated: false,
			},
		};
		expect(
			rulesFor(
				[fires("c.both", { inputs: ["statement", "execution"] })],
				context,
			).length,
		).toBe(1);
	});

	test("nothing runs on an empty context", () => {
		expect(rulesFor([fires("a.b")], {})).toEqual([]);
	});
});

describe("runRules", () => {
	test("collects findings from every applicable rule", () => {
		const result = runRules([fires("a.b"), fires("c.d")], { statement });
		expect(result.findings.map((finding) => finding.ruleId)).toEqual([
			"a.b",
			"c.d",
		]);
		expect(result.failed).toEqual([]);
	});

	test("a rule that throws costs its own output and nothing else", () => {
		// A broken rule must not take the other rules' findings with it.
		const broken: Rule = {
			id: "broken.rule",
			severity: "warning",
			inputs: ["statement"],
			evaluate: () => {
				throw new Error("bug in the rule");
			},
		};
		const result = runRules([broken, fires("a.b")], { statement });
		expect(result.findings.map((finding) => finding.ruleId)).toEqual(["a.b"]);
		expect(result.failed).toEqual(["broken.rule"]);
	});

	test("a rule that cannot tell contributes nothing and is not a failure", () => {
		const silent: Rule = {
			id: "silent.rule",
			severity: "warning",
			inputs: ["statement"],
			evaluate: () => [],
		};
		const result = runRules([silent], { statement });
		expect(result.findings).toEqual([]);
		expect(result.failed).toEqual([]);
	});
});

describe("sortFindings", () => {
	const at = (start: number): Finding["at"] => ({
		kind: "document",
		documentId: "doc-1",
		start,
		end: start + 1,
	});

	test("worst first, then by position", () => {
		const findings: Finding[] = [
			{ ruleId: "s.one", severity: "style", at: at(10), facts: {} },
			{ ruleId: "b.two", severity: "blocker", at: at(50), facts: {} },
			{ ruleId: "b.one", severity: "blocker", at: at(5), facts: {} },
			{ ruleId: "w.one", severity: "warning", at: at(1), facts: {} },
		];
		expect(sortFindings(findings).map((finding) => finding.ruleId)).toEqual([
			"b.one",
			"b.two",
			"w.one",
			"s.one",
		]);
	});

	test("the order is stable for findings at the same place", () => {
		// An unstable panel reorders under the pointer as findings arrive.
		const findings: Finding[] = [
			{ ruleId: "z.rule", severity: "warning", at: at(0), facts: {} },
			{ ruleId: "a.rule", severity: "warning", at: at(0), facts: {} },
		];
		expect(sortFindings(findings).map((finding) => finding.ruleId)).toEqual([
			"a.rule",
			"z.rule",
		]);
	});

	test("does not mutate the input", () => {
		const findings: Finding[] = [
			{ ruleId: "s.one", severity: "style", at: at(10), facts: {} },
			{ ruleId: "b.one", severity: "blocker", at: at(5), facts: {} },
		];
		sortFindings(findings);
		expect(findings[0]?.ruleId).toBe("s.one");
	});
});
