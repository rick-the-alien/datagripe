import type { Finding, GripeSeverity } from "@datagripe/contracts";
import { GRIPE_SEVERITIES } from "@datagripe/contracts";
import type { GripeContext, Rule, RuleInput } from "./types";

/**
 * The runner (docs/spec/gripes.md "Where rules run, and why it is
 * split").
 *
 * One catalogue, two callers. A rule declares its inputs; the runner
 * runs only the rules whose inputs it can supply, so the client runs
 * statement/schema/object rules over what it already holds and the
 * server runs execution rules where the connection is. Neither knows
 * about the other, and a rule knows about neither.
 */

function availableInputs(context: GripeContext): Set<RuleInput> {
	const available = new Set<RuleInput>();
	if (context.statement !== undefined) {
		available.add("statement");
	}
	if (context.schema !== undefined) {
		available.add("schema");
	}
	if (context.object !== undefined) {
		available.add("object");
	}
	if (context.execution !== undefined) {
		available.add("execution");
	}
	return available;
}

export function rulesFor(rules: Rule[], context: GripeContext): Rule[] {
	const available = availableInputs(context);
	return rules.filter((rule) =>
		rule.inputs.every((input) => available.has(input)),
	);
}

const SEVERITY_ORDER = new Map<GripeSeverity, number>(
	GRIPE_SEVERITIES.map((severity, index) => [severity, index]),
);

/**
 * Worst first, then by position so a document reads top to bottom. A
 * stable order matters more than it sounds: an unstable panel reorders
 * under the pointer as findings arrive.
 */
export function sortFindings(findings: Finding[]): Finding[] {
	return [...findings].sort((a, b) => {
		const bySeverity =
			(SEVERITY_ORDER.get(a.severity) ?? 99) -
			(SEVERITY_ORDER.get(b.severity) ?? 99);
		if (bySeverity !== 0) {
			return bySeverity;
		}
		const aStart = a.at.kind === "document" ? a.at.start : 0;
		const bStart = b.at.kind === "document" ? b.at.start : 0;
		if (aStart !== bStart) {
			return aStart - bStart;
		}
		return a.ruleId.localeCompare(b.ruleId);
	});
}

/**
 * A rule that throws is a bug in the rule, and it must not take the
 * other rules' findings with it — a broken rule should cost its own
 * output and nothing else.
 */
export interface RunResult {
	findings: Finding[];
	/** Rule ids that threw, for logging. Never surfaced as gripes. */
	failed: string[];
}

export function runRules(rules: Rule[], context: GripeContext): RunResult {
	const findings: Finding[] = [];
	const failed: string[] = [];
	for (const rule of rulesFor(rules, context)) {
		try {
			findings.push(...rule.evaluate(context));
		} catch {
			failed.push(rule.id);
		}
	}
	return { findings: sortFindings(findings), failed };
}
