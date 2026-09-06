import type { AttitudeLevel, Finding, GripeFacts } from "@datagripe/contracts";

/**
 * Turning a finding into a sentence (docs/spec/gripes.md "Findings are
 * analysis; wording is presentation").
 *
 * Four fixed strings per rule, written by a human. No generation, no
 * template shuffling, no synonym rotation — "the same rule firing twice
 * uses the same wording. Never generate variants to seem clever."
 */

/** The four strings for one rule. All four are required. */
export interface MessageSet {
	notice: string;
	warning: string;
	fatal: string;
	panic: string;
}

/**
 * A missing level is not allowed to fall back. Falling back to
 * `warning` is how a level silently stops existing, and `fatal` quietly
 * becoming `warning` would make the setting a lie.
 */
export type MessageCatalogue = Record<string, MessageSet>;

/** Thrown when a finding names a rule the catalogue does not have. */
export class UnknownRuleError extends Error {
	constructor(ruleId: string) {
		super(`No wording for rule '${ruleId}'`);
		this.name = "UnknownRuleError";
	}
}

const PLACEHOLDER = /\{(\w+)\}/g;

/** Thousands-separated, because "41,203,882 rows" is the whole point. */
function formatFact(value: string | number): string {
	return typeof value === "number" ? value.toLocaleString("en-US") : value;
}

/**
 * Substitute facts into a template. An unknown placeholder is left as
 * written rather than blanked: a gripe reading "no index on {column}" is
 * obviously broken, where "no index on " reads like a bug in the
 * database.
 */
export function interpolate(template: string, facts: GripeFacts): string {
	return template.replaceAll(PLACEHOLDER, (whole, name: string) => {
		const value = facts[name];
		return value === undefined ? whole : formatFact(value);
	});
}

export function renderFinding(
	finding: Finding,
	attitude: AttitudeLevel,
	catalogue: MessageCatalogue,
): string {
	const messages = catalogue[finding.ruleId];
	if (messages === undefined) {
		throw new UnknownRuleError(finding.ruleId);
	}
	return interpolate(messages[attitude], finding.facts);
}

/**
 * The factual footer, which is what makes a complaint auditable:
 * severity, rule id, and the line when there is one. Never affected by
 * attitude — the register changes, the evidence does not.
 */
export function renderFooter(
	finding: Finding,
	options: { line?: number } = {},
): string {
	const parts = [finding.severity, ...finding.ruleId.split(".")];
	if (options.line !== undefined) {
		parts.push(`line ${options.line}`);
	}
	return parts.join(" · ");
}

/** 1-based line of an offset, for the footer. */
export function lineOfOffset(text: string, offset: number): number {
	let line = 1;
	for (let i = 0; i < offset && i < text.length; i++) {
		if (text[i] === "\n") {
			line++;
		}
	}
	return line;
}
