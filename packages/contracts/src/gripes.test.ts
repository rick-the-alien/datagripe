import { describe, expect, test } from "bun:test";
import type { Dismissal, Finding } from "./gripes";
import { isDismissed, objectTargetKey } from "./gripes";

/** Which dismissals silence which findings (docs/spec/gripes.md). */

const documentFinding: Finding = {
	ruleId: "join.no-condition",
	severity: "blocker",
	at: { kind: "document", documentId: "doc-1", start: 10, end: 14 },
	facts: {},
	fingerprint: "deadbeef",
};

const objectFinding: Finding = {
	ruleId: "table.no-primary-key",
	severity: "warning",
	at: {
		kind: "object",
		connectionId: "c",
		schema: "shop",
		name: "orders",
		objectKind: "table",
	},
	facts: {},
};

describe("no dismissals", () => {
	test("nothing is hidden", () => {
		expect(isDismissed(documentFinding, [])).toBe(false);
	});
});

describe("project scope", () => {
	test("silences the rule everywhere", () => {
		const dismissal: Dismissal = {
			ruleId: "join.no-condition",
			scope: "project",
			key: null,
		};
		expect(isDismissed(documentFinding, [dismissal])).toBe(true);
	});

	test("and only that rule", () => {
		expect(
			isDismissed(objectFinding, [
				{ ruleId: "join.no-condition", scope: "project", key: null },
			]),
		).toBe(false);
	});
});

describe("target scope", () => {
	test("silences the rule in one document", () => {
		expect(
			isDismissed(documentFinding, [
				{ ruleId: "join.no-condition", scope: "target", key: "doc-1" },
			]),
		).toBe(true);
	});

	test("and not in another", () => {
		expect(
			isDismissed(documentFinding, [
				{ ruleId: "join.no-condition", scope: "target", key: "doc-2" },
			]),
		).toBe(false);
	});

	test("silences the rule on one object", () => {
		expect(
			isDismissed(objectFinding, [
				{
					ruleId: "table.no-primary-key",
					scope: "target",
					key: objectTargetKey("shop", "orders"),
				},
			]),
		).toBe(true);
	});

	test("and not on a same-named object in another schema", () => {
		expect(
			isDismissed(objectFinding, [
				{
					ruleId: "table.no-primary-key",
					scope: "target",
					key: objectTargetKey("archive", "orders"),
				},
			]),
		).toBe(false);
	});
});

describe("occurrence scope", () => {
	test("silences one statement by fingerprint", () => {
		expect(
			isDismissed(documentFinding, [
				{ ruleId: "join.no-condition", scope: "occurrence", key: "deadbeef" },
			]),
		).toBe(true);
	});

	test("a different statement is untouched", () => {
		// The whole point of keying on text: editing this statement, or
		// finding the same problem elsewhere, is not covered.
		expect(
			isDismissed(documentFinding, [
				{ ruleId: "join.no-condition", scope: "occurrence", key: "cafebabe" },
			]),
		).toBe(false);
	});

	test("a finding with no fingerprint is never occurrence-dismissed", () => {
		// An object finding has no statement behind it, so there is nothing
		// stable to key on and the scope simply does not apply.
		expect(
			isDismissed(objectFinding, [
				{
					ruleId: "table.no-primary-key",
					scope: "occurrence",
					key: "deadbeef",
				},
			]),
		).toBe(false);
	});
});

describe("several dismissals", () => {
	test("any one matching is enough", () => {
		expect(
			isDismissed(documentFinding, [
				{ ruleId: "other.rule", scope: "project", key: null },
				{ ruleId: "join.no-condition", scope: "target", key: "doc-1" },
			]),
		).toBe(true);
	});

	test("none matching leaves it visible", () => {
		expect(
			isDismissed(documentFinding, [
				{ ruleId: "other.rule", scope: "project", key: null },
				{ ruleId: "join.no-condition", scope: "target", key: "doc-9" },
			]),
		).toBe(false);
	});
});
