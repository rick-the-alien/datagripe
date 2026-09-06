import type { SqlDialect } from "@datagripe/sql-tools";
import { scanTokens, splitOptionsForDialect } from "@datagripe/sql-tools";
import type { StatementInput } from "./types";

/**
 * Build a statement input for the runner. Tokenizing once here rather
 * than in each rule keeps the cost linear in statements, not in rules.
 */
export function statementInputFor(options: {
	documentId: string;
	dialect: SqlDialect;
	text: string;
	offset?: number;
}): StatementInput {
	return {
		documentId: options.documentId,
		dialect: options.dialect,
		text: options.text,
		offset: options.offset ?? 0,
		tokens: scanTokens(options.text, splitOptionsForDialect(options.dialect)),
	};
}
