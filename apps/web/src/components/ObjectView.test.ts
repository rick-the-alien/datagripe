import { describe, expect, test } from "bun:test";
import type { Finding, GripeSeverity, ObjectTab } from "@datagripe/contracts";
import { defaultTabForKind } from "@datagripe/contracts";
import { worstSeverityForTab } from "./ObjectView";

/**
 * The tab strip's finding marks (docs/spec/gripes.md "Object view").
 * A finding is scoped to the tab its subject lives in, so without a mark
 * the worst gripe in an object can sit behind a tab nobody clicks.
 */

function finding(severity: GripeSeverity, tab?: ObjectTab): Finding {
	return {
		ruleId: `x.${severity}`,
		severity,
		at: {
			kind: "object",
			connectionId: "conn-1",
			schema: "shop",
			name: "orders",
			objectKind: "table",
			...(tab === undefined ? {} : { tab }),
		},
		facts: {},
	};
}

describe("worstSeverityForTab", () => {
	test("null when the tab has no findings", () => {
		expect(
			worstSeverityForTab([finding("blocker", "ddl")], "columns"),
		).toBeNull();
	});

	test("the tab's own severity", () => {
		expect(worstSeverityForTab([finding("style", "indexes")], "indexes")).toBe(
			"style",
		);
	});

	test("the worst of several, not the first", () => {
		const findings = [
			finding("style", "ddl"),
			finding("blocker", "ddl"),
			finding("warning", "ddl"),
		];
		expect(worstSeverityForTab(findings, "ddl")).toBe("blocker");
	});

	test("a finding with no tab marks every tab", () => {
		const findings = [finding("warning")];
		expect(worstSeverityForTab(findings, "ddl")).toBe("warning");
		expect(worstSeverityForTab(findings, "grants")).toBe("warning");
	});

	test("document findings never mark a tab", () => {
		const document: Finding = {
			ruleId: "join.no-condition",
			severity: "blocker",
			at: { kind: "document", documentId: "doc-1", start: 0, end: 4 },
			facts: {},
		};
		expect(worstSeverityForTab([document], "ddl")).toBeNull();
	});
});

describe("defaultTabForKind", () => {
	test("a routine opens on its definition", () => {
		// Where its gripes are, and a security-definer escalation is a
		// blocker that must not be behind an unclicked tab.
		expect(defaultTabForKind("function")).toBe("ddl");
		expect(defaultTabForKind("procedure")).toBe("ddl");
	});

	test("a relation still opens on its columns", () => {
		expect(defaultTabForKind("table")).toBe("columns");
		expect(defaultTabForKind("view")).toBe("columns");
	});

	test("a sequence opens on the counter that is all it has", () => {
		expect(defaultTabForKind("sequence")).toBe("statistics");
	});
});
