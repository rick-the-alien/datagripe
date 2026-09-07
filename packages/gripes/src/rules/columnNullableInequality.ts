import type { Finding } from "@datagripe/contracts";
import type { SqlToken } from "@datagripe/sql-tools";
import { documentLocation, type Rule } from "../types";
import { columnRefEndingAt, relationFor, tablesInScope } from "./tables";

/**
 * `column.nullable-inequality` — `col <> 'x'` where `col` is nullable,
 * which silently drops every row where it is null.
 *
 * This is the schema knowing something the statement cannot say. Read as
 * English, "status <> 'void'" means everything that is not void, and
 * nulls are obviously not void. Read as SQL it means the comparison
 * evaluates to unknown for those rows, so they are excluded — no error,
 * no warning, just a result that is missing rows the author expected.
 *
 * Deliberately *not* the equality case. Most columns are nullable and
 * `col = 'x'` excluding nulls is what everyone expects, so griping at it
 * would fire on half the queries in the tool and get the whole feature
 * switched off. The negation is where the reading and the behaviour come
 * apart.
 */

const NEGATIONS = new Set(["<>", "!="]);

/** A literal on the right, so this is a filter and not a column join. */
function isLiteral(token: SqlToken | undefined): boolean {
	return (
		token !== undefined && (token.kind === "string" || token.kind === "number")
	);
}

export const columnNullableInequality: Rule = {
	id: "column.nullable-inequality",
	severity: "warning",
	inputs: ["statement", "schema"],

	evaluate(context) {
		const statement = context.statement;
		const schema = context.schema;
		if (statement === undefined || schema === undefined) {
			return [];
		}
		const tokens = statement.tokens;
		const scope = tablesInScope(tokens);
		const findings: Finding[] = [];
		for (const [index, token] of tokens.entries()) {
			// Depth 0 only: a predicate inside a subquery resolves against
			// tables `tablesInScope` cannot see, and answering from the outer
			// query's tables would be confidently wrong.
			if (
				token.kind !== "punct" ||
				token.depth !== 0 ||
				!NEGATIONS.has(token.text) ||
				!isLiteral(tokens[index + 1])
			) {
				continue;
			}
			const ref = columnRefEndingAt(tokens, index - 1);
			if (ref === null) {
				continue;
			}
			const relation = relationFor(scope, ref);
			if (relation === null) {
				continue;
			}
			// `null` is "not known", and a rule that gets it stays silent.
			if (
				schema.isNullable(relation.schema, relation.name, ref.column) !== true
			) {
				continue;
			}
			const name = tokens[ref.at];
			if (name === undefined) {
				continue;
			}
			findings.push({
				ruleId: columnNullableInequality.id,
				severity: columnNullableInequality.severity,
				at: documentLocation(statement, name.start, token.end),
				facts: { column: ref.column },
			});
		}
		return findings;
	},
};
