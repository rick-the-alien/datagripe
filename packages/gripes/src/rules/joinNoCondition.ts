import type { Finding } from "@datagripe/contracts";
import type { SqlToken } from "@datagripe/sql-tools";
import { documentLocation, type Rule } from "../types";

/**
 * `join.no-condition` — a join with no `ON` and no `USING`, which is a
 * cross product however it was meant.
 *
 * This is the brand spec's own worked example, with its wording given at
 * all four attitude levels, so implementing it is not a choice about
 * which rules ship (docs/spec/gripes.md "Candidate rules").
 */

/**
 * A join that legitimately has no condition. `CROSS JOIN` says cross
 * product out loud, and `NATURAL JOIN` derives its condition from the
 * column names. Firing on either would be a wrong gripe, and a wrong
 * gripe destroys trust in every other gripe.
 */
const DELIBERATE = new Set(["cross", "natural"]);

/**
 * Words that end the search for a condition. Past any of these, an `ON`
 * belongs to something else.
 */
const BOUNDARY = new Set([
	"where",
	"group",
	"having",
	"order",
	"limit",
	"offset",
	"fetch",
	"window",
	"union",
	"intersect",
	"except",
	"returning",
	"for",
	"into",
]);

/** How far back to look for `cross` / `natural`, which may be two words. */
const FLAVOUR_LOOKBACK = 3;

function isDeliberate(tokens: SqlToken[], joinIndex: number): boolean {
	for (
		let i = joinIndex - 1;
		i >= 0 && i >= joinIndex - FLAVOUR_LOOKBACK;
		i--
	) {
		const token = tokens[i];
		if (token === undefined || token.kind !== "word" || token.quoted) {
			continue;
		}
		if (DELIBERATE.has(token.text)) {
			return true;
		}
		// `left`, `right`, `full`, `inner`, `outer`, `lateral` all still need
		// a condition; anything else means we have walked out of the join
		// flavour and can stop.
		if (
			!["left", "right", "full", "inner", "outer", "lateral"].includes(
				token.text,
			)
		) {
			return false;
		}
	}
	return false;
}

/** True when this join gets an `ON` or `USING` before its clause ends. */
function hasCondition(tokens: SqlToken[], joinIndex: number): boolean {
	const joinDepth = tokens[joinIndex]?.depth ?? 0;
	for (let i = joinIndex + 1; i < tokens.length; i++) {
		const token = tokens[i] as SqlToken;
		// The subquery this join lives in has closed.
		if (token.depth < joinDepth) {
			return false;
		}
		if (token.kind !== "word" || token.quoted) {
			continue;
		}
		// A condition nested deeper belongs to a nested join, not this one.
		if (token.depth === joinDepth) {
			if (token.text === "on" || token.text === "using") {
				return true;
			}
			if (token.text === "join" || BOUNDARY.has(token.text)) {
				return false;
			}
		}
	}
	return false;
}

export const joinNoCondition: Rule = {
	id: "join.no-condition",
	severity: "blocker",
	inputs: ["statement"],

	evaluate(context) {
		const statement = context.statement;
		if (statement === undefined) {
			return [];
		}
		const findings: Finding[] = [];
		for (const [index, token] of statement.tokens.entries()) {
			if (
				token.kind !== "word" ||
				token.quoted ||
				token.text !== "join" ||
				isDeliberate(statement.tokens, index) ||
				hasCondition(statement.tokens, index)
			) {
				continue;
			}
			findings.push({
				ruleId: joinNoCondition.id,
				severity: joinNoCondition.severity,
				at: documentLocation(statement, token.start, token.end),
				facts: {},
			});
		}
		return findings;
	},
};
