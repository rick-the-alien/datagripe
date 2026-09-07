import type { Finding } from "@datagripe/contracts";
import type { SqlToken } from "@datagripe/sql-tools";
import { documentLocation, type Rule } from "../types";

/**
 * `subquery.not-in` — `NOT IN (SELECT ...)`, which returns no rows at
 * all if the subquery yields a single null.
 *
 * This earns its place because it is silent: the query does not fail, it
 * answers zero rows and looks like a legitimate empty result. Nothing in
 * the statement text tells you whether the subquery's column is
 * nullable, and it can become nullable later without this query being
 * touched, so the shape itself is the finding.
 *
 * A positive `IN (SELECT ...)` is deliberately not a finding: a null
 * there simply fails to match, which is what a reader expects.
 */

/** True when the token at `index` opens a parenthesised `SELECT`. */
function opensSubquery(tokens: SqlToken[], index: number): boolean {
	const open = tokens[index];
	if (open === undefined || open.kind !== "punct" || open.text !== "(") {
		return false;
	}
	const first = tokens[index + 1];
	return (
		first !== undefined &&
		first.kind === "word" &&
		!first.quoted &&
		(first.text === "select" || first.text === "with")
	);
}

export const subqueryNotIn: Rule = {
	id: "subquery.not-in",
	severity: "warning",
	inputs: ["statement"],

	evaluate(context) {
		const statement = context.statement;
		if (statement === undefined) {
			return [];
		}
		const tokens = statement.tokens;
		const findings: Finding[] = [];
		for (const [index, token] of tokens.entries()) {
			if (token.kind !== "word" || token.quoted || token.text !== "not") {
				continue;
			}
			const next = tokens[index + 1];
			// Only the adjacent `NOT IN` form. `NOT EXISTS` is the correct
			// idiom and must never be griped at, and `NOT (x IN ...)` is rare
			// enough that catching it is not worth the risk of catching
			// something else.
			if (
				next === undefined ||
				next.kind !== "word" ||
				next.quoted ||
				next.text !== "in" ||
				!opensSubquery(tokens, index + 2)
			) {
				continue;
			}
			findings.push({
				ruleId: subqueryNotIn.id,
				severity: subqueryNotIn.severity,
				at: documentLocation(statement, token.start, next.end),
				facts: {},
			});
		}
		return findings;
	},
};
