import { joinNoCondition } from "./rules/joinNoCondition";
import type { Rule } from "./types";

/**
 * The rule registry (docs/spec/gripes.md).
 *
 * **This is not the catalogue.** The brand spec reserves which rules
 * ship for its own design pass — it calls the catalogue "the actual
 * product" — and what is here is the one rule whose wording the brand
 * spec itself worked out at all four attitude levels, present so the
 * machinery around it is exercised by something real rather than a
 * fixture.
 *
 * Adding a rule means: a file in `rules/`, an entry here, four strings
 * in `messages.ts`, and three fixtures in its test — one that fires, one
 * that does not, and one that cannot tell and must stay silent.
 */
export const RULES: Rule[] = [joinNoCondition];

export function ruleById(id: string): Rule | undefined {
	return RULES.find((rule) => rule.id === id);
}
