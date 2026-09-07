import type { SqlToken } from "@datagripe/sql-tools";

/**
 * Resolving a column reference to the relation it belongs to
 * (docs/spec/gripes.md).
 *
 * A schema-input rule almost always starts here: it has a column name
 * from the statement and needs to ask the schema something about it,
 * which means knowing which table it came from. The web app's completion
 * code does the same job by scanning raw strings; this works on tokens,
 * so comments, string literals and quoted identifiers are already
 * handled correctly.
 *
 * Only the statement's own scope is read. A reference inside a subquery
 * resolves against tables this does not see, so a rule must treat a
 * nested reference as unknown and stay silent rather than resolve it
 * against the outer query's tables and be confidently wrong.
 */

export interface TableRef {
	schema: string | null;
	name: string;
}

/** Clauses that introduce a relation. */
const INTRODUCERS = new Set(["from", "join", "update", "into"]);

/**
 * Words that can follow a relation but are never its alias. Missing one
 * here means a keyword gets recorded as an alias, and the rule then
 * resolves a real column against a table that does not exist.
 */
const NEVER_AN_ALIAS = new Set([
	"on",
	"using",
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
	"join",
	"left",
	"right",
	"inner",
	"outer",
	"full",
	"cross",
	"natural",
	"lateral",
	"set",
	"values",
	"select",
	"for",
	"with",
	"and",
	"or",
	"tablesample",
]);

function isWord(token: SqlToken | undefined): token is SqlToken {
	return token !== undefined && token.kind === "word";
}

function isPunct(token: SqlToken | undefined, text: string): boolean {
	return token !== undefined && token.kind === "punct" && token.text === text;
}

/** Read `schema.name [AS] alias` starting at `index`. */
function readTableRef(
	tokens: SqlToken[],
	index: number,
): { ref: TableRef; alias: string | null; end: number } | null {
	const first = tokens[index];
	if (!isWord(first)) {
		return null;
	}
	let cursor = index + 1;
	let ref: TableRef = { schema: null, name: first.text };
	if (isPunct(tokens[cursor], ".")) {
		const second = tokens[cursor + 1];
		if (!isWord(second)) {
			return null;
		}
		ref = { schema: first.text, name: second.text };
		cursor += 2;
	}
	let alias: string | null = null;
	if (isWord(tokens[cursor]) && tokens[cursor]?.text === "as") {
		cursor += 1;
		const named = tokens[cursor];
		if (isWord(named)) {
			alias = named.text;
			cursor += 1;
		}
	} else {
		const named = tokens[cursor];
		// A bare alias, but only when the word cannot be a clause keyword.
		if (isWord(named) && (named.quoted || !NEVER_AN_ALIAS.has(named.text))) {
			alias = named.text;
			cursor += 1;
		}
	}
	return { ref, alias, end: cursor };
}

/**
 * The statement's top-level relations, keyed by every name they can be
 * referred to by — the alias when there is one, and the bare table name,
 * which stays valid as a qualifier in SQL either way.
 */
export function tablesInScope(tokens: SqlToken[]): Map<string, TableRef> {
	const scope = new Map<string, TableRef>();
	let index = 0;
	while (index < tokens.length) {
		const token = tokens[index];
		if (
			token === undefined ||
			token.kind !== "word" ||
			token.quoted ||
			token.depth !== 0 ||
			!INTRODUCERS.has(token.text)
		) {
			index += 1;
			continue;
		}
		let cursor = index + 1;
		// `insert into t` and `from only t` put a noise word first.
		if (isWord(tokens[cursor]) && tokens[cursor]?.text === "only") {
			cursor += 1;
		}
		const read = readTableRef(tokens, cursor);
		if (read === null) {
			index += 1;
			continue;
		}
		let current: typeof read | null = read;
		while (current !== null) {
			scope.set(current.ref.name, current.ref);
			if (current.alias !== null) {
				scope.set(current.alias, current.ref);
			}
			cursor = current.end;
			if (!isPunct(tokens[cursor], ",")) {
				break;
			}
			current = readTableRef(tokens, cursor + 1);
		}
		index = cursor;
	}
	return scope;
}

export interface ColumnRef {
	qualifier: string | null;
	column: string;
	/** The token index of the column name, for locating the finding. */
	at: number;
}

/**
 * Read the column reference ending at `index`, which is the token
 * immediately left of an operator. Returns null when the operand is a
 * literal, a function call or anything else this cannot name.
 */
export function columnRefEndingAt(
	tokens: SqlToken[],
	index: number,
): ColumnRef | null {
	const name = tokens[index];
	if (!isWord(name)) {
		return null;
	}
	// A function call: the name belongs to the call, not to a column, and
	// an expression index may well cover it.
	if (isPunct(tokens[index - 1], ")")) {
		return null;
	}
	if (isPunct(tokens[index - 1], ".")) {
		const qualifier = tokens[index - 2];
		if (!isWord(qualifier)) {
			return null;
		}
		return { qualifier: qualifier.text, column: name.text, at: index };
	}
	return { qualifier: null, column: name.text, at: index };
}

/**
 * The relation a column reference belongs to, or null when that cannot
 * be established — an unknown qualifier, or a bare column in a
 * statement with more than one relation in scope, where guessing would
 * mean asking the schema about the wrong table.
 */
export function relationFor(
	scope: Map<string, TableRef>,
	ref: ColumnRef,
): TableRef | null {
	if (ref.qualifier !== null) {
		return scope.get(ref.qualifier) ?? null;
	}
	const distinct = new Map<string, TableRef>();
	for (const table of scope.values()) {
		distinct.set(`${table.schema ?? ""}.${table.name}`, table);
	}
	if (distinct.size !== 1) {
		return null;
	}
	return [...distinct.values()][0] ?? null;
}
