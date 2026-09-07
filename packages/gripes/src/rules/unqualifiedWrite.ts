import type { Finding } from "@datagripe/contracts";
import { documentLocation, type Rule } from "../types";
import { hasTopLevelWhere, indexOfKeyword, leadingVerb } from "./shape";

/**
 * `delete.no-where` and `update.no-where` — a write with no `WHERE`,
 * which touches every row in the table.
 *
 * Both are blockers and both are derivable from the statement text
 * alone. That looks like it brushes against the spec's "a finding
 * derivable from the query text alone is usually a lint rule" non-goal,
 * and it does not: that rule is about *style* filler. An unqualified
 * DELETE is not untidy, it is about to remove every row.
 */

function unqualifiedWrite(verb: "delete" | "update"): Rule {
	return {
		id: `${verb}.no-where`,
		severity: "blocker",
		inputs: ["statement"],

		evaluate(context) {
			const statement = context.statement;
			if (statement === undefined) {
				return [];
			}
			const tokens = statement.tokens;
			// The main verb, not any occurrence: `create trigger t after
			// delete on x` has no WHERE and is not a delete.
			if (leadingVerb(tokens) !== verb) {
				return [];
			}
			const at = indexOfKeyword(tokens, verb);
			if (at < 0 || hasTopLevelWhere(tokens, at)) {
				return [];
			}
			const token = tokens[at];
			if (token === undefined) {
				return [];
			}
			const findings: Finding[] = [
				{
					ruleId: `${verb}.no-where`,
					severity: "blocker",
					at: documentLocation(statement, token.start, token.end),
					facts: {},
				},
			];
			return findings;
		},
	};
}

export const deleteNoWhere = unqualifiedWrite("delete");
export const updateNoWhere = unqualifiedWrite("update");
