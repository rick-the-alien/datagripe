import { ATTITUDE_LEVELS } from "@datagripe/contracts";
import type { MessageCatalogue } from "./render";
import type { Rule } from "./types";

/**
 * Mechanical checks over the catalogue (docs/spec/gripes.md "Testing").
 *
 * These are the brand spec's acceptance checks, turned into assertions
 * that run once for every rule. They catch the failures a reviewer
 * misses — a missing `fatal` string, a sentence that outgrew the cap —
 * and they deliberately do not try to judge whether a gripe is funny.
 * That stays a review gate.
 *
 * Each function returns problems rather than throwing, so a test can
 * report all of them at once instead of one per run.
 */

/** Under 90 characters at `notice` and `warning` (brand spec). */
const LENGTH_CAP = 90;
const CAPPED_LEVELS = ["notice", "warning"] as const;

const ID_PATTERN = /^[a-z][a-z0-9]*(-[a-z0-9]+)*\.[a-z][a-z0-9]*(-[a-z0-9]+)*$/;

const PLACEHOLDER = /\{(\w+)\}/g;

export function placeholdersIn(template: string): string[] {
	return [...template.matchAll(PLACEHOLDER)].map((match) => match[1] as string);
}

/** Every rule has all four strings, and none may be blank. */
export function assertEveryLevelPresent(
	rules: Rule[],
	catalogue: MessageCatalogue,
): string[] {
	const problems: string[] = [];
	for (const rule of rules) {
		const messages = catalogue[rule.id];
		if (messages === undefined) {
			problems.push(`${rule.id}: no wording at all`);
			continue;
		}
		for (const level of ATTITUDE_LEVELS) {
			const text = messages[level];
			// A missing level must not fall back: that is how a level
			// silently stops existing.
			if (text === undefined || text.trim() === "") {
				problems.push(`${rule.id}: no '${level}' string`);
			}
		}
	}
	return problems;
}

export function assertLengthCap(catalogue: MessageCatalogue): string[] {
	const problems: string[] = [];
	for (const [ruleId, messages] of Object.entries(catalogue)) {
		for (const level of CAPPED_LEVELS) {
			const text = messages[level];
			if (text !== undefined && text.length > LENGTH_CAP) {
				problems.push(
					`${ruleId}: '${level}' is ${text.length} chars, cap is ${LENGTH_CAP}`,
				);
			}
		}
	}
	return problems;
}

function containsWord(text: string, word: string): boolean {
	// Word-boundary matching, so "hello" is not "hell" and "class" is not
	// "ass". A substring check here would be worse than no check.
	return new RegExp(`\\b${word}\\b`, "i").test(text);
}

/** `notice` is "No profanity. Dry and still critical." */
export function assertNoticeIsClean(
	catalogue: MessageCatalogue,
	profanity: string[],
): string[] {
	const problems: string[] = [];
	for (const [ruleId, messages] of Object.entries(catalogue)) {
		for (const word of profanity) {
			if (containsWord(messages.notice ?? "", word)) {
				problems.push(`${ruleId}: 'notice' contains '${word}'`);
			}
		}
	}
	return problems;
}

/**
 * Barred at every level, `panic` included. "Swearing at a query is
 * funny; punching downward is not, and it is the one thing that would
 * follow the product around."
 *
 * The list is a parameter so this is testable without the real one, and
 * so the real one stays a single reviewed constant.
 */
export function assertNoBarredTerms(
	catalogue: MessageCatalogue,
	barred: string[],
): string[] {
	const problems: string[] = [];
	for (const [ruleId, messages] of Object.entries(catalogue)) {
		for (const level of ATTITUDE_LEVELS) {
			for (const term of barred) {
				if (containsWord(messages[level] ?? "", term)) {
					problems.push(`${ruleId}: '${level}' contains a barred term`);
				}
			}
		}
	}
	return problems;
}

export function assertIdsAreWellFormed(rules: Rule[]): string[] {
	const problems: string[] = [];
	const seen = new Set<string>();
	for (const rule of rules) {
		if (!ID_PATTERN.test(rule.id)) {
			problems.push(`${rule.id}: not <subject>.<problem> in lower-kebab`);
		}
		if (seen.has(rule.id)) {
			problems.push(`${rule.id}: duplicate id`);
		}
		seen.add(rule.id);
	}
	return problems;
}

/** A rule declares inputs, and a statement rule that reads nothing is a bug. */
export function assertInputsDeclared(rules: Rule[]): string[] {
	return rules
		.filter((rule) => rule.inputs.length === 0)
		.map((rule) => `${rule.id}: declares no inputs, so it can never run`);
}

/**
 * Every rule the catalogue words must exist, or the wording is dead
 * weight that will drift out of step with the rule it describes.
 */
export function assertNoOrphanWording(
	rules: Rule[],
	catalogue: MessageCatalogue,
): string[] {
	const ids = new Set(rules.map((rule) => rule.id));
	return Object.keys(catalogue)
		.filter((ruleId) => !ids.has(ruleId))
		.map((ruleId) => `${ruleId}: wording for a rule that does not exist`);
}

export interface CatalogueProblems {
	problems: string[];
}

/** Everything at once, for one test that reports the whole picture. */
export function checkCatalogue(
	rules: Rule[],
	catalogue: MessageCatalogue,
	options: { profanity: string[]; barred: string[] },
): CatalogueProblems {
	return {
		problems: [
			...assertIdsAreWellFormed(rules),
			...assertInputsDeclared(rules),
			...assertEveryLevelPresent(rules, catalogue),
			...assertNoOrphanWording(rules, catalogue),
			...assertLengthCap(catalogue),
			...assertNoticeIsClean(catalogue, options.profanity),
			...assertNoBarredTerms(catalogue, options.barred),
		],
	};
}
