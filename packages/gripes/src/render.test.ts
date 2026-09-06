import { describe, expect, test } from "bun:test";
import type { Finding } from "@datagripe/contracts";
import {
	interpolate,
	lineOfOffset,
	renderFinding,
	renderFooter,
	UnknownRuleError,
} from "./render";

const CATALOGUE = {
	"index.missing": {
		notice:
			"Unqualified select * across {rows} rows, and {column} has no index.",
		warning: "select * across {rows} rows and sod all in the way of an index.",
		fatal: "{rows} rows, select *, and no bloody index on {column}.",
		panic: "{rows} rows. No index. What in the absolute hell is this.",
	},
};

const finding: Finding = {
	ruleId: "index.missing",
	severity: "blocker",
	at: { kind: "document", documentId: "doc-1", start: 7, end: 8 },
	facts: { rows: 41203882, column: "status" },
};

describe("interpolate", () => {
	test("numbers are thousands-separated", () => {
		// "41,203,882 rows" is the specificity the brand spec asks for.
		expect(interpolate("{rows} rows", { rows: 41203882 })).toBe(
			"41,203,882 rows",
		);
	});

	test("strings go in as written", () => {
		expect(interpolate("no index on {column}", { column: "status" })).toBe(
			"no index on status",
		);
	});

	test("an unknown placeholder is left visible, not blanked", () => {
		// "no index on {column}" is obviously broken; "no index on " reads
		// like a bug in the database.
		expect(interpolate("no index on {column}", {})).toBe(
			"no index on {column}",
		);
	});

	test("a repeated placeholder is filled every time", () => {
		expect(interpolate("{n} and {n}", { n: 2 })).toBe("2 and 2");
	});

	test("text with no placeholders is untouched", () => {
		expect(interpolate("This join has no condition.", {})).toBe(
			"This join has no condition.",
		);
	});
});

describe("renderFinding", () => {
	test("the same finding reads differently at each level", () => {
		const texts = (["notice", "warning", "fatal", "panic"] as const).map(
			(level) => renderFinding(finding, level, CATALOGUE),
		);
		expect(new Set(texts).size).toBe(4);
	});

	test("the technical content is identical across levels", () => {
		// "The technical content never changes between levels — only the
		// register." Every level names the row count.
		for (const level of ["notice", "warning", "fatal", "panic"] as const) {
			expect(renderFinding(finding, level, CATALOGUE)).toContain("41,203,882");
		}
	});

	test("a rule with no wording is an error, not an empty string", () => {
		expect(() =>
			renderFinding(
				{ ...finding, ruleId: "nope.missing" },
				"warning",
				CATALOGUE,
			),
		).toThrow(UnknownRuleError);
	});
});

describe("renderFooter", () => {
	test("severity, rule id and line, so the complaint is auditable", () => {
		expect(renderFooter(finding, { line: 4 })).toBe(
			"blocker · index · missing · line 4",
		);
	});

	test("no line when there is none to give", () => {
		expect(renderFooter(finding)).toBe("blocker · index · missing");
	});

	test("the footer does not change with attitude", () => {
		// The register changes; the evidence does not. The footer takes no
		// attitude argument at all, which is how that is enforced.
		expect(renderFooter(finding)).toBe(renderFooter(finding));
	});
});

describe("lineOfOffset", () => {
	test("counts from 1", () => {
		expect(lineOfOffset("select 1", 0)).toBe(1);
		expect(lineOfOffset("a\nb\nc", 4)).toBe(3);
	});

	test("an offset past the end does not run away", () => {
		expect(lineOfOffset("a\nb", 999)).toBe(2);
	});
});
