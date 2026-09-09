import type { SqlDialect } from "@datagripe/sql-tools";
import {
	scanTokens,
	splitOptionsForDialect,
	splitStatements,
} from "@datagripe/sql-tools";

/**
 * Layer 1 of read-only mode (docs/spec/mcp.md "Read-only"): refuse the
 * write before a connection is reserved.
 *
 * This is the layer that actually stops writes, and the reason the
 * refusal is worth more than a rollback: an agent told "this project's
 * MCP server is read-only" can ask its human for the other mode, while
 * an agent whose UPDATE silently vanished reports a change that never
 * happened.
 *
 * It runs on tokens rather than text, so `-- delete everything` is a
 * comment and `where action = 'drop'` is a string. What it cannot see —
 * a function that writes, a sequence that advances — is what layers 2
 * and 3 are for.
 */

/** A statement may only begin with one of these. */
const ALLOWED_LEADING = new Set([
	"select",
	"with",
	"values",
	"table",
	"explain",
	"show",
]);

/**
 * Words that cannot appear anywhere in a read, at any nesting depth.
 *
 * Depth matters: `WITH x AS (INSERT … RETURNING *) SELECT * FROM x`
 * starts with an allowed word and writes, and its `insert` sits one
 * paren deep. `into` is here for `SELECT … INTO new_table`, and
 * `update` doubles as the check on `SELECT … FOR UPDATE`.
 *
 * Kept deliberately tight. `replace` is a string function, `comment` is
 * a plausible column name, and a set this size would refuse ordinary
 * reads for no gain — those are caught by the leading-word check
 * instead. A quoted identifier is never a keyword, so `select "update"
 * from t` is a column and passes.
 */
const DENIED_ANYWHERE = new Set([
	"insert",
	"update",
	"delete",
	"merge",
	"truncate",
	"drop",
	"alter",
	"create",
	"grant",
	"revoke",
	"into",
	"vacuum",
	"reindex",
	"analyze",
	"cluster",
	"lock",
	"savepoint",
	"commit",
	"rollback",
	"call",
	"do",
	"attach",
	"detach",
	"pragma",
]);

export interface ReadOnlyRefusal {
	/** The statement, trimmed, as the message should quote it. */
	statement: string;
	/** The word that decided it. */
	word: string;
}

/**
 * The first statement this mode will not run, or null when every one of
 * them is a read.
 */
export function refuseWrites(
	sql: string,
	dialect: SqlDialect,
): ReadOnlyRefusal | null {
	const options = splitOptionsForDialect(dialect);
	for (const statement of splitStatements(sql, options)) {
		const tokens = scanTokens(statement.text, options);
		const words = tokens.filter(
			(token) => token.kind === "word" && !token.quoted,
		);
		const leading = words[0];
		if (leading === undefined) {
			continue; // comments only — nothing to run and nothing to refuse
		}
		if (!ALLOWED_LEADING.has(leading.text)) {
			return { statement: statement.text, word: leading.text };
		}
		const denied = words.find((word) => DENIED_ANYWHERE.has(word.text));
		if (denied !== undefined) {
			return { statement: statement.text, word: denied.text };
		}
	}
	return null;
}

/** The refusal an agent reads. It names the toggle, so it can ask. */
export function refusalMessage(refusal: ReadOnlyRefusal): string {
	const preview =
		refusal.statement.length > 120
			? `${refusal.statement.slice(0, 117)}…`
			: refusal.statement;
	return [
		`This project's MCP server is read-only, so '${refusal.word}' cannot run.`,
		"An owner can switch it to read/write in DataGripe's mcp panel;",
		"a datasource marked read only stays read-only either way.",
		`Refused: ${preview}`,
	].join(" ");
}
