import type { Finding } from "@datagripe/contracts";
import { documentLocation, type Rule } from "../types";
import { indexOfKeyword, isProjectionStar, leadingVerb } from "./shape";

/**
 * `view.select-star` — a view defined with `SELECT *`, whose column list
 * is frozen at the moment it is created.
 *
 * This knows something the text does not say: the star is not a
 * standing instruction. The database expands it once, at creation, and
 * records the result. Add a column to the underlying table and the view
 * will never show it; the star has already been spent. Every reader of
 * the definition assumes the opposite.
 */
export const viewSelectStar: Rule = {
	id: "view.select-star",
	severity: "warning",
	inputs: ["statement"],

	evaluate(context) {
		const statement = context.statement;
		if (statement === undefined) {
			return [];
		}
		const tokens = statement.tokens;
		if (leadingVerb(tokens) !== "create") {
			return [];
		}
		// `view` at depth 0 covers `create view`, `create or replace view`
		// and `create materialized view` alike. A column named `view` inside
		// a `create table (...)` sits deeper.
		if (indexOfKeyword(tokens, "view") === -1) {
			return [];
		}
		const findings: Finding[] = [];
		for (let i = 0; i < tokens.length; i++) {
			if (!isProjectionStar(tokens, i)) {
				continue;
			}
			const star = tokens[i];
			if (star === undefined) {
				continue;
			}
			findings.push({
				ruleId: viewSelectStar.id,
				severity: viewSelectStar.severity,
				at: documentLocation(statement, star.start, star.end),
				facts: {},
			});
		}
		return findings;
	},
};
