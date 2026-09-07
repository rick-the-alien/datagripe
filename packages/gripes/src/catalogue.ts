import { indexDuplicate } from "./rules/indexDuplicate";
import { joinNoCondition } from "./rules/joinNoCondition";
import { routineDefinerNoSearchPath } from "./rules/routineDefinerNoSearchPath";
import { routineVolatileButReadonly } from "./rules/routineVolatileButReadonly";
import { tableNoPrimaryKey } from "./rules/tableNoPrimaryKey";
import { deleteNoWhere, updateNoWhere } from "./rules/unqualifiedWrite";
import type { Rule } from "./types";

/**
 * The rule catalogue (docs/spec/gripes.md).
 *
 * Every rule here earns its place by knowing something the query text
 * alone does not, or by being about damage rather than tidiness. What is
 * deliberately absent is style filler — a formatter's job, and the
 * fastest way to make people disable the whole thing.
 *
 * Adding a rule means: a file in `rules/`, an entry here, four strings
 * in `messages.ts`, and three fixtures in its test — one that fires, one
 * that does not, and one that cannot tell and must stay silent.
 */
export const RULES: Rule[] = [
	// statement
	joinNoCondition,
	deleteNoWhere,
	updateNoWhere,
	// object
	routineDefinerNoSearchPath,
	tableNoPrimaryKey,
	indexDuplicate,
	routineVolatileButReadonly,
];

export function ruleById(id: string): Rule | undefined {
	return RULES.find((rule) => rule.id === id);
}
