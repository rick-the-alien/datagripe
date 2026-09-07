import type { Finding } from "@datagripe/contracts";
import { documentLocation, type Rule } from "../types";
import { indexOfKeyword, leadingVerb } from "./shape";

/**
 * `index.not-concurrent` — `CREATE INDEX` without `CONCURRENTLY`, which
 * holds a lock that blocks every write to the table until the build
 * finishes.
 *
 * The damage is invisible in development, where the table is small and
 * the build takes a moment. On a large table the same statement stops
 * writes for as long as the scan takes, which is how a routine index
 * becomes an outage.
 *
 * Postgres only, and gated on the dialect rather than the adapter id:
 * MySQL manages this with its own algorithm options and SQLite has no
 * equivalent, so the advice would be wrong there rather than merely
 * unhelpful.
 */
export const indexNotConcurrent: Rule = {
	id: "index.not-concurrent",
	severity: "warning",
	inputs: ["statement"],

	evaluate(context) {
		const statement = context.statement;
		if (statement === undefined || statement.dialect !== "postgres") {
			return [];
		}
		const tokens = statement.tokens;
		if (leadingVerb(tokens) !== "create") {
			return [];
		}
		const indexAt = indexOfKeyword(tokens, "index");
		if (indexAt === -1 || indexOfKeyword(tokens, "concurrently") !== -1) {
			return [];
		}
		const token = tokens[indexAt];
		if (token === undefined) {
			return [];
		}
		const finding: Finding = {
			ruleId: indexNotConcurrent.id,
			severity: indexNotConcurrent.severity,
			at: documentLocation(statement, token.start, token.end),
			facts: {},
		};
		return [finding];
	},
};
