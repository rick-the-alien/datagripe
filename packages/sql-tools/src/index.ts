/**
 * PostgreSQL statement splitting (docs/spec/query-execution.md): single
 * pass, aware of single-quoted strings (incl. E'' backslash escapes),
 * quoted identifiers, line comments, nestable block comments, and
 * dollar-quoted bodies. Splitting happens only on top-level semicolons.
 */

export interface SqlStatement {
	/** Trimmed statement text (surrounding whitespace removed). */
	text: string;
	/** Offset of the first character in the original text. */
	start: number;
	/** Offset one past the last character in the original text. */
	end: number;
}

export interface SplitOptions {
	/** MySQL/SQLite allow backslash escapes inside strings. */
	backslashEscapes?: boolean;
	/** MySQL/SQLite quote identifiers with backticks. */
	backtickIdentifiers?: boolean;
}

const DIALECT_OPTIONS: Record<string, SplitOptions> = {
	postgres: {},
	mysql: { backslashEscapes: true, backtickIdentifiers: true },
	sqlite: { backtickIdentifiers: true },
};

export type SqlDialect = keyof typeof DIALECT_OPTIONS;

type DollarQuote = { tag: string };

function readDollarQuoteTag(sql: string, at: number): DollarQuote | null {
	// $tag$ where tag is empty or an unquoted identifier (letters, digits,
	// underscore; must not start with a digit).
	let i = at + 1;
	let tag = "";
	while (i < sql.length) {
		const ch = sql[i];
		if (ch === "$") {
			if (i === at + 1) {
				return { tag: "" };
			}
			return /^[A-Za-z_][A-Za-z0-9_]*$/.test(tag) ? { tag } : null;
		}
		if (!/[A-Za-z0-9_]/.test(ch ?? "")) {
			return null;
		}
		tag += ch;
		i++;
	}
	return null;
}

export function splitOptionsForDialect(dialect: SqlDialect): SplitOptions {
	return DIALECT_OPTIONS[dialect] ?? {};
}

export function splitStatements(
	sql: string,
	options: SplitOptions = {},
): SqlStatement[] {
	const statements: SqlStatement[] = [];
	let i = 0;
	/** Start of the current segment's first code character, -1 = none yet. */
	let codeStart = -1;

	const flush = (endExclusive: number) => {
		if (codeStart === -1) {
			return;
		}
		let end = endExclusive;
		while (end > codeStart && /\s/.test(sql[end - 1] ?? "")) {
			end--;
		}
		if (end > codeStart) {
			statements.push({
				text: sql.slice(codeStart, end),
				start: codeStart,
				end,
			});
		}
		codeStart = -1;
	};

	while (i < sql.length) {
		const ch = sql[i] as string;
		const next = sql[i + 1];

		// Line comment
		if (ch === "-" && next === "-") {
			const eol = sql.indexOf("\n", i + 2);
			i = eol === -1 ? sql.length : eol + 1;
			continue;
		}
		// Block comment (PostgreSQL nests them)
		if (ch === "/" && next === "*") {
			let depth = 1;
			i += 2;
			while (i < sql.length && depth > 0) {
				if (sql[i] === "/" && sql[i + 1] === "*") {
					depth++;
					i += 2;
				} else if (sql[i] === "*" && sql[i + 1] === "/") {
					depth--;
					i += 2;
				} else {
					i++;
				}
			}
			continue;
		}
		// Single-quoted string; E'' (postgres) and dialect backslash escapes
		if (
			ch === "'" ||
			(ch === "E" && next === "'") ||
			(ch === "e" && next === "'")
		) {
			const extended = ch !== "'" || options.backslashEscapes === true;
			if (codeStart === -1) {
				codeStart = i;
			}
			i = ch !== "'" ? i + 2 : i + 1;
			while (i < sql.length) {
				if (extended && sql[i] === "\\") {
					i += 2;
					continue;
				}
				if (sql[i] === "'") {
					if (sql[i + 1] === "'") {
						i += 2;
						continue;
					}
					i++;
					break;
				}
				i++;
			}
			continue;
		}
		// Quoted identifier ("…" or dialect backticks)
		if (ch === '"' || (ch === "`" && options.backtickIdentifiers === true)) {
			const quote = ch;
			if (codeStart === -1) {
				codeStart = i;
			}
			i++;
			while (i < sql.length) {
				if (sql[i] === quote) {
					if (sql[i + 1] === quote) {
						i += 2;
						continue;
					}
					i++;
					break;
				}
				i++;
			}
			continue;
		}
		// Dollar-quoted body
		if (ch === "$") {
			const quote = readDollarQuoteTag(sql, i);
			if (quote !== null) {
				if (codeStart === -1) {
					codeStart = i;
				}
				const open = `$${quote.tag}$`;
				const closeAt = sql.indexOf(open, i + open.length);
				i = closeAt === -1 ? sql.length : closeAt + open.length;
				continue;
			}
		}
		// Top-level semicolon ends the statement
		if (ch === ";") {
			flush(i);
			i++;
			continue;
		}

		if (codeStart === -1 && !/\s/.test(ch)) {
			codeStart = i;
		}
		i++;
	}

	flush(sql.length);
	return statements;
}

/**
 * The statement containing `offset`. When the offset sits in the gap
 * between two statements, the following statement wins; at the very end,
 * the last statement. Returns null when there are no statements.
 */
export function statementAt(
	sql: string,
	offset: number,
	options: SplitOptions = {},
): SqlStatement | null {
	const statements = splitStatements(sql, options);
	if (statements.length === 0) {
		return null;
	}
	for (const statement of statements) {
		if (offset <= statement.end) {
			return statement;
		}
	}
	return statements[statements.length - 1] ?? null;
}

const READ_PATTERN = /^(?:select|with|values|table)\b/i;

/**
 * Whether a statement is row-returning and therefore runs through a
 * server-side cursor. Leading comments never set a statement's code
 * start, so the first re-split statement begins at real code.
 *
 * `with` is optimistic: `WITH … SELECT` cursors fine, but `WITH …
 * INSERT/UPDATE/DELETE` is not cursor-eligible. The adapter falls back
 * to direct execution when DECLARE fails, so a misclassification is a
 * retry, never a user-facing error.
 */
export function isRowReturningStatement(
	statement: string,
	options: SplitOptions = {},
): boolean {
	const [code] = splitStatements(statement, options);
	return code !== undefined && READ_PATTERN.test(code.text);
}
