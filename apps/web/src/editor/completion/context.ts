/**
 * Statement-local completion context. Pure string scanning — no Monaco,
 * no stores — so it is fully unit-testable. The tokenizer understands
 * single/double-quoted strings and line/block comments just well enough
 * to skip them; it is not a full SQL parser.
 */

export type TableRef = {
	schema?: string | undefined;
	name: string;
	alias?: string | undefined;
};

export type StatementTables = {
	tables: TableRef[];
	/** Alias (and bare table name) → resolved table reference. */
	aliasToTable: Map<string, { schema?: string | undefined; name: string }>;
};

export type CompletionContext =
	| { kind: "dot"; qualifier: string }
	| { kind: "tablePosition" }
	| { kind: "general" };

type Token = {
	type: "word" | "dot" | "comma" | "other";
	value: string;
};

const UNQUOTED_IDENTIFIER = /^[A-Za-z_][A-Za-z0-9_$]*/;

/** Keywords that introduce a table reference. */
const TABLE_POSITION_KEYWORDS = new Set([
	"FROM",
	"JOIN",
	"UPDATE",
	"INTO",
	"TRUNCATE",
]);

/** Words that may follow a table reference but are never an alias. */
const CLAUSE_KEYWORDS = new Set([
	"WHERE",
	"ON",
	"USING",
	"SET",
	"VALUES",
	"RETURNING",
	"GROUP",
	"ORDER",
	"LIMIT",
	"OFFSET",
	"HAVING",
	"UNION",
	"INTERSECT",
	"EXCEPT",
	"LEFT",
	"RIGHT",
	"INNER",
	"OUTER",
	"FULL",
	"CROSS",
	"JOIN",
	"NATURAL",
	"FROM",
	"INTO",
	"UPDATE",
	"TABLE",
	"SELECT",
	"AS",
	"AND",
	"OR",
	"NOT",
	"WHEN",
	"CASE",
	"WINDOW",
	"FETCH",
	"FOR",
	"ASC",
	"DESC",
]);

/** Strip the quotes from a `"quoted"` identifier, unescaping `""`. */
export function unquoteIdentifier(raw: string): string {
	if (raw.startsWith('"') && raw.endsWith('"') && raw.length >= 2) {
		return raw.slice(1, -1).replace(/""/g, '"');
	}
	return raw;
}

/**
 * Tokenize SQL into words/dots/commas, skipping string literals,
 * quoted-pair content and comments. Quoted identifiers keep their quotes
 * in `value` so callers can unquote deliberately.
 */
function tokenize(sql: string): Token[] {
	const tokens: Token[] = [];
	let index = 0;
	while (index < sql.length) {
		const char = sql[index] as string;
		const next = sql[index + 1];
		if (/\s/.test(char)) {
			index += 1;
			continue;
		}
		// Line comment.
		if (char === "-" && next === "-") {
			const end = sql.indexOf("\n", index + 2);
			index = end === -1 ? sql.length : end + 1;
			continue;
		}
		// Block comment.
		if (char === "/" && next === "*") {
			const end = sql.indexOf("*/", index + 2);
			index = end === -1 ? sql.length : end + 2;
			continue;
		}
		// Single-quoted string ('' escape).
		if (char === "'") {
			index += 1;
			while (index < sql.length) {
				if (sql[index] === "'" && sql[index + 1] === "'") {
					index += 2;
					continue;
				}
				if (sql[index] === "'") {
					index += 1;
					break;
				}
				index += 1;
			}
			continue;
		}
		// Double-quoted identifier ("" escape) — a word, not a string.
		if (char === '"') {
			const start = index;
			index += 1;
			while (index < sql.length) {
				if (sql[index] === '"' && sql[index + 1] === '"') {
					index += 2;
					continue;
				}
				if (sql[index] === '"') {
					index += 1;
					break;
				}
				index += 1;
			}
			tokens.push({ type: "word", value: sql.slice(start, index) });
			continue;
		}
		if (char === ".") {
			tokens.push({ type: "dot", value: "." });
			index += 1;
			continue;
		}
		if (char === ",") {
			tokens.push({ type: "comma", value: "," });
			index += 1;
			continue;
		}
		const identifier = UNQUOTED_IDENTIFIER.exec(sql.slice(index));
		if (identifier !== null) {
			tokens.push({ type: "word", value: identifier[0] });
			index += identifier[0].length;
			continue;
		}
		tokens.push({ type: "other", value: char });
		index += 1;
	}
	return tokens;
}

function isKeyword(token: Token): boolean {
	return (
		token.type === "word" && CLAUSE_KEYWORDS.has(token.value.toUpperCase())
	);
}

/**
 * Read a `[schema.]table [[AS] alias]` reference starting at `start`.
 * Returns the ref and the index just past it, or null when the token at
 * `start` cannot begin a table reference (subquery, function call, …).
 */
function readTableRef(
	tokens: Token[],
	start: number,
): { ref: TableRef; end: number } | null {
	const first = tokens[start];
	if (first === undefined || first.type !== "word" || isKeyword(first)) {
		return null;
	}
	let index = start;
	let schema: string | undefined;
	let name = unquoteIdentifier(first.value);
	if (tokens[index + 1]?.type === "dot" && tokens[index + 2]?.type === "word") {
		schema = name;
		name = unquoteIdentifier((tokens[index + 2] as Token).value);
		index += 2;
	}
	const ref: TableRef = { schema, name };
	index += 1;
	const maybeAs = tokens[index];
	if (maybeAs?.type === "word" && maybeAs.value.toUpperCase() === "AS") {
		const alias = tokens[index + 1];
		if (alias !== undefined && alias.type === "word" && !isKeyword(alias)) {
			ref.alias = unquoteIdentifier(alias.value);
			index += 2;
			return { ref, end: index };
		}
	}
	const maybeAlias = tokens[index];
	if (
		maybeAlias !== undefined &&
		maybeAlias.type === "word" &&
		!isKeyword(maybeAlias)
	) {
		ref.alias = unquoteIdentifier(maybeAlias.value);
		index += 1;
	}
	return { ref, end: index };
}

/**
 * Scan a statement for the tables it references: FROM/JOIN/UPDATE/INTO
 * clauses, including comma joins and quoted identifiers. Subqueries are
 * skipped rather than recursed into — completion only needs the outer
 * scope's aliases.
 */
export function parseStatementTables(statementText: string): StatementTables {
	const tokens = tokenize(statementText);
	const tables: TableRef[] = [];
	let index = 0;
	while (index < tokens.length) {
		const token = tokens[index] as Token;
		const upper = token.value.toUpperCase();
		if (
			token.type === "word" &&
			(upper === "FROM" ||
				upper === "JOIN" ||
				upper === "UPDATE" ||
				upper === "INTO")
		) {
			let cursor = index + 1;
			const first = readTableRef(tokens, cursor);
			if (first !== null) {
				tables.push(first.ref);
				cursor = first.end;
				// Comma joins: FROM a, b AS c, …
				while (tokens[cursor]?.type === "comma") {
					const next = readTableRef(tokens, cursor + 1);
					if (next === null) {
						break;
					}
					tables.push(next.ref);
					cursor = next.end;
				}
				index = cursor;
				continue;
			}
		}
		index += 1;
	}
	const aliasToTable = new Map<
		string,
		{ schema?: string | undefined; name: string }
	>();
	for (const table of tables) {
		aliasToTable.set(table.name, { schema: table.schema, name: table.name });
		if (table.alias !== undefined) {
			aliasToTable.set(table.alias, {
				schema: table.schema,
				name: table.name,
			});
		}
	}
	return { tables, aliasToTable };
}

/**
 * Classify the cursor position within its statement:
 *  - `dot`: right after `qualifier.` — complete columns or schema members.
 *  - `tablePosition`: after FROM/JOIN/UPDATE/INTO/TRUNCATE — complete tables.
 *  - `general`: anything else — aliases, columns, tables, keywords.
 */
export function completionContext(
	textBeforeCursorInStatement: string,
	_statementText: string,
): CompletionContext {
	const tokens = tokenize(textBeforeCursorInStatement);
	if (tokens.length === 0) {
		return { kind: "general" };
	}
	const last = tokens[tokens.length - 1] as Token;
	if (last.type === "dot") {
		const before = tokens[tokens.length - 2];
		if (before !== undefined && before.type === "word") {
			return { kind: "dot", qualifier: unquoteIdentifier(before.value) };
		}
		return { kind: "general" };
	}
	// Skip the partial word being typed, then walk back over identifiers,
	// dots and commas to the previous keyword that governs this position.
	let index = tokens.length - 1;
	if (
		last.type === "word" &&
		!CLAUSE_KEYWORDS.has(last.value.toUpperCase()) &&
		!TABLE_POSITION_KEYWORDS.has(last.value.toUpperCase())
	) {
		index -= 1;
	}
	while (index >= 0) {
		const token = tokens[index] as Token;
		if (token.type === "word") {
			const upper = token.value.toUpperCase();
			if (CLAUSE_KEYWORDS.has(upper) || TABLE_POSITION_KEYWORDS.has(upper)) {
				return TABLE_POSITION_KEYWORDS.has(upper)
					? { kind: "tablePosition" }
					: { kind: "general" };
			}
		}
		if (token.type === "other") {
			return { kind: "general" };
		}
		index -= 1;
	}
	return { kind: "general" };
}
