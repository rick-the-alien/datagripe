import {
	type SplitOptions,
	type SqlDialect,
	splitOptionsForDialect,
} from "./index";

/**
 * SQL formatter — what Ctrl+Alt+L runs in the editor
 * (docs/spec/editor-workspace.md "Formatting").
 *
 * Not a parser: a formatter that needed a grammar per dialect would
 * refuse to lay out the statement a user is halfway through typing. This
 * works on the token stream, recognising clause keywords, parens and
 * CASE, and lays them out with one rule everywhere — a construct stays
 * on one line while it fits inside `maxWidth`, and breaks at its own
 * separators when it does not.
 *
 * Two invariants, because a formatter that loses SQL is worse than no
 * formatter:
 *
 * - Only whitespace and keyword case ever change. Identifiers, literals
 *   and comments are copied verbatim.
 * - The result is re-tokenized and compared against the input before it
 *   is returned. Any difference — a comma dropped from malformed input,
 *   an unbalanced paren — returns the original text untouched.
 */

export interface FormatOptions {
	/** Governs string and identifier quoting quirks while tokenizing. */
	dialect?: SqlDialect;
	/** One indent level. The editor passes the model's own tab settings. */
	indent?: string;
	/** Lines break to stay inside this width where the shape allows. */
	maxWidth?: number;
	/** Keywords are upper-cased by default; identifiers never change. */
	keywordCase?: "upper" | "preserve";
}

const DEFAULT_INDENT = "    ";
const DEFAULT_MAX_WIDTH = 100;

/**
 * Words upper-cased when `keywordCase` is `"upper"`. Deliberately
 * conservative: type names, function names, and words that are commonly
 * column names stay as the author typed them, so formatting a document
 * does not shout `SELECT STATUS, VALUE`.
 */
const KEYWORDS = new Set([
	"add",
	"all",
	"alter",
	"always",
	"analyze",
	"and",
	"any",
	"as",
	"asc",
	"begin",
	"between",
	"by",
	"cascade",
	"case",
	"cast",
	"check",
	"column",
	"commit",
	"conflict",
	"constraint",
	"copy",
	"create",
	"cross",
	"database",
	"default",
	"delete",
	"desc",
	"distinct",
	"do",
	"drop",
	"else",
	"end",
	"escape",
	"except",
	"exists",
	"explain",
	"extension",
	"false",
	"fetch",
	"filter",
	"following",
	"for",
	"foreign",
	"from",
	"full",
	"function",
	"generated",
	"grant",
	"group",
	"having",
	"identity",
	"if",
	"ilike",
	"in",
	"index",
	"inner",
	"insert",
	"intersect",
	"into",
	"is",
	"join",
	"key",
	"lateral",
	"left",
	"like",
	"limit",
	"matched",
	"materialized",
	"merge",
	"natural",
	"no",
	"not",
	"nothing",
	"null",
	"nulls",
	"offset",
	"on",
	"only",
	"or",
	"order",
	"outer",
	"over",
	"partition",
	"preceding",
	"primary",
	"privileges",
	"procedure",
	"recursive",
	"references",
	"rename",
	"replace",
	"restrict",
	"returning",
	"revoke",
	"right",
	"rollback",
	"savepoint",
	"schema",
	"select",
	"sequence",
	"set",
	"similar",
	"some",
	"table",
	"temp",
	"temporary",
	"then",
	"to",
	"trigger",
	"true",
	"truncate",
	"unbounded",
	"union",
	"unique",
	"unlogged",
	"update",
	"using",
	"vacuum",
	"verbose",
	"view",
	"when",
	"where",
	"window",
	"with",
	"within",
]);

/** A clause: the keyword sequence that earns a line of its own. */
interface ClauseSpec {
	/** Lower-case words, matched longest-first. */
	words: string[];
	/**
	 * Joins and ALTER actions hang one level under the clause they
	 * qualify, the way a reader scans them: FROM first, then its joins.
	 */
	indent?: 1;
	/**
	 * A paren straight after a name is a function call everywhere except
	 * here, where it is a column list: `CREATE TABLE t (…)`, not `t(…)`.
	 */
	padParen?: true;
	/**
	 * The rest of the statement belongs to this clause, whatever words it
	 * contains: `GRANT SELECT ON t TO r` is one line, not a GRANT with a
	 * SELECT hanging under it.
	 */
	opaque?: true;
}

const CLAUSES: ClauseSpec[] = [
	{ words: ["with"] },
	{ words: ["with", "recursive"] },
	{ words: ["select"] },
	{ words: ["select", "all"] },
	{ words: ["select", "distinct"] },
	{ words: ["select", "distinct", "on"] },
	{ words: ["from"] },
	{ words: ["where"] },
	{ words: ["group", "by"] },
	{ words: ["having"] },
	{ words: ["window"] },
	{ words: ["order", "by"] },
	{ words: ["limit"] },
	{ words: ["offset"] },
	{ words: ["fetch", "first"] },
	{ words: ["fetch", "next"] },
	{ words: ["for", "update"] },
	{ words: ["for", "share"] },
	{ words: ["union"] },
	{ words: ["union", "all"] },
	{ words: ["union", "distinct"] },
	{ words: ["intersect"] },
	{ words: ["intersect", "all"] },
	{ words: ["except"] },
	{ words: ["except", "all"] },
	{ words: ["join"], indent: 1 },
	{ words: ["inner", "join"], indent: 1 },
	{ words: ["left", "join"], indent: 1 },
	{ words: ["left", "outer", "join"], indent: 1 },
	{ words: ["right", "join"], indent: 1 },
	{ words: ["right", "outer", "join"], indent: 1 },
	{ words: ["full", "join"], indent: 1 },
	{ words: ["full", "outer", "join"], indent: 1 },
	{ words: ["cross", "join"], indent: 1 },
	{ words: ["natural", "join"], indent: 1 },
	{ words: ["natural", "left", "join"], indent: 1 },
	{ words: ["insert", "into"], padParen: true },
	{ words: ["values"] },
	{ words: ["on", "conflict"] },
	{ words: ["do", "update", "set"] },
	{ words: ["do", "nothing"] },
	{ words: ["returning"] },
	{ words: ["update"] },
	{ words: ["set"] },
	{ words: ["delete", "from"] },
	{ words: ["using"] },
	{ words: ["merge", "into"] },
	{ words: ["when", "matched"] },
	{ words: ["when", "not", "matched"] },
	{ words: ["create", "table"], padParen: true },
	{ words: ["create", "temporary", "table"], padParen: true },
	{ words: ["create", "temp", "table"], padParen: true },
	{ words: ["create", "unlogged", "table"], padParen: true },
	{ words: ["create", "view"], padParen: true },
	{ words: ["create", "or", "replace", "view"], padParen: true },
	{ words: ["create", "materialized", "view"], padParen: true },
	{ words: ["create", "index"], padParen: true },
	{ words: ["create", "unique", "index"], padParen: true },
	{ words: ["create", "function"] },
	{ words: ["create", "or", "replace", "function"] },
	{ words: ["create", "procedure"] },
	{ words: ["create", "or", "replace", "procedure"] },
	{ words: ["create", "trigger"] },
	{ words: ["alter", "table"] },
	{ words: ["add", "column"], indent: 1 },
	{ words: ["add", "constraint"], indent: 1 },
	{ words: ["drop", "column"], indent: 1 },
	{ words: ["alter", "column"], indent: 1 },
	{ words: ["rename", "to"], indent: 1 },
	{ words: ["rename", "column"], indent: 1 },
	{ words: ["drop", "table"] },
	{ words: ["drop", "view"] },
	{ words: ["drop", "index"] },
	{ words: ["truncate"] },
	{ words: ["truncate", "table"] },
	{ words: ["comment", "on"], opaque: true },
	{ words: ["grant"], opaque: true },
	{ words: ["revoke"], opaque: true },
	{ words: ["explain"] },
	{ words: ["explain", "analyze"] },
	{ words: ["analyze"] },
	{ words: ["vacuum"] },
	{ words: ["begin"] },
	{ words: ["commit"] },
	{ words: ["rollback"] },
	{ words: ["savepoint"] },
];

// Longest first, so `LEFT OUTER JOIN` is matched before `JOIN`, and
// `SELECT DISTINCT ON` before `SELECT`.
CLAUSES.sort((left, right) => right.words.length - left.words.length);

/** A paren whose first word is one of these holds a query, not a list. */
const QUERY_STARTS = new Set([
	"select",
	"with",
	"values",
	"table",
	"insert",
	"update",
	"delete",
]);

type RawKind =
	| "word"
	| "quoted"
	| "string"
	| "number"
	| "param"
	| "punct"
	| "lineComment"
	| "blockComment";

interface Raw {
	kind: RawKind;
	/** Verbatim source text; only a `word` is ever re-cased. */
	text: string;
	/** Newlines in the whitespace before it — the blank-line memory. */
	breaks: number;
}

/** Mirrors the splitter's dollar-quote reader (`$tag$…$tag$`). */
function dollarQuoteTag(sql: string, at: number): string | null {
	let i = at + 1;
	let tag = "";
	while (i < sql.length) {
		const ch = sql[i];
		if (ch === "$") {
			return i === at + 1 || /^[A-Za-z_][A-Za-z0-9_]*$/.test(tag) ? tag : null;
		}
		if (!/[A-Za-z0-9_]/.test(ch ?? "")) {
			return null;
		}
		tag += ch;
		i++;
	}
	return null;
}

/** Multi-character operators, longest first. */
const OPERATORS = [
	"->>",
	"#>>",
	"<->",
	"<>",
	"!=",
	"<=",
	">=",
	"||",
	"::",
	"->",
	"#>",
	"@>",
	"<@",
	"<<",
	">>",
	"!~",
	"~*",
	":=",
];

const PUNCT = new Set([
	",",
	";",
	"(",
	")",
	"[",
	"]",
	".",
	"*",
	"+",
	"-",
	"/",
	"%",
	"=",
	"<",
	">",
	"|",
	"&",
	"^",
	"~",
	"!",
	"@",
	"#",
	"?",
	":",
	"{",
	"}",
]);

/**
 * Lossless tokenizer. `scanTokens` drops comments and unquotes
 * identifiers, which is right for a lint rule and fatal for a
 * formatter: everything here has to survive the round trip.
 */
function tokenize(sql: string, options: SplitOptions): Raw[] {
	const tokens: Raw[] = [];
	let i = 0;
	let breaks = 0;

	const push = (kind: RawKind, text: string): void => {
		tokens.push({ kind, text, breaks });
		breaks = 0;
	};

	while (i < sql.length) {
		const ch = sql[i] as string;
		const next = sql[i + 1];

		if (/\s/.test(ch)) {
			if (ch === "\n") {
				breaks++;
			}
			i++;
			continue;
		}
		if (ch === "-" && next === "-") {
			const eol = sql.indexOf("\n", i + 2);
			const end = eol === -1 ? sql.length : eol;
			push("lineComment", sql.slice(i, end).replace(/\s+$/, ""));
			i = end;
			continue;
		}
		if (ch === "/" && next === "*") {
			const start = i;
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
			push("blockComment", sql.slice(start, i));
			continue;
		}
		if (
			ch === "'" ||
			(ch === "E" && next === "'") ||
			(ch === "e" && next === "'")
		) {
			const start = i;
			const extended = ch !== "'" || options.backslashEscapes === true;
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
			push("string", sql.slice(start, i));
			continue;
		}
		if (ch === '"' || (ch === "`" && options.backtickIdentifiers === true)) {
			const start = i;
			const quote = ch;
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
			push("quoted", sql.slice(start, i));
			continue;
		}
		if (ch === "$") {
			const tag = dollarQuoteTag(sql, i);
			if (tag !== null) {
				const start = i;
				const open = `$${tag}$`;
				const closeAt = sql.indexOf(open, i + open.length);
				i = closeAt === -1 ? sql.length : closeAt + open.length;
				push("string", sql.slice(start, i));
				continue;
			}
			if (/[0-9]/.test(next ?? "")) {
				const start = i;
				i++;
				while (i < sql.length && /[0-9]/.test(sql[i] ?? "")) {
					i++;
				}
				push("param", sql.slice(start, i));
				continue;
			}
		}
		if (ch === ":" && next !== ":" && /[A-Za-z_]/.test(next ?? "")) {
			const start = i;
			i++;
			while (i < sql.length && /[A-Za-z0-9_]/.test(sql[i] ?? "")) {
				i++;
			}
			push("param", sql.slice(start, i));
			continue;
		}
		if (/[0-9]/.test(ch)) {
			const start = i;
			while (i < sql.length && /[0-9._eE]/.test(sql[i] ?? "")) {
				i++;
			}
			push("number", sql.slice(start, i));
			continue;
		}
		if (/[A-Za-z_]/.test(ch)) {
			const start = i;
			while (i < sql.length && /[A-Za-z0-9_$]/.test(sql[i] ?? "")) {
				i++;
			}
			push("word", sql.slice(start, i));
			continue;
		}
		const operator = OPERATORS.find((candidate) =>
			sql.startsWith(candidate, i),
		);
		if (operator !== undefined) {
			push("punct", operator);
			i += operator.length;
			continue;
		}
		if (PUNCT.has(ch)) {
			push("punct", ch);
			i++;
			continue;
		}
		// An unrecognised character must not vanish either: it is kept as
		// punctuation, and the round-trip check decides whether the layout
		// it landed in survived.
		push("punct", ch);
		i++;
	}

	return tokens;
}

function isKeyword(token: Raw | undefined): boolean {
	return (
		token !== undefined &&
		token.kind === "word" &&
		KEYWORDS.has(token.text.toLowerCase())
	);
}

const NO_SPACE_BEFORE = new Set([",", ";", ")", "]", "::", "."]);
const NO_SPACE_AFTER = new Set(["(", "[", "::", "."]);
/** After one of these, a `-`/`+` is a sign on the operand that follows. */
const SIGN_CONTEXT = new Set([
	"(",
	"[",
	",",
	"=",
	"<",
	">",
	"<=",
	">=",
	"<>",
	"!=",
	"+",
	"-",
	"*",
	"/",
	"%",
	"||",
	"::",
]);

/** Whether a space separates `token` from the token before it. */
function needsSpace(
	prev2: Raw | undefined,
	prev: Raw | undefined,
	token: Raw,
): boolean {
	if (prev === undefined) {
		return false;
	}
	if (
		prev.kind === "punct" &&
		(prev.text === "-" || prev.text === "+") &&
		(prev2 === undefined ||
			isKeyword(prev2) ||
			(prev2.kind === "punct" && SIGN_CONTEXT.has(prev2.text)))
	) {
		return false;
	}
	if (token.kind === "punct") {
		if (token.text === "(") {
			// `count(*)` is a call. `IN (…)`, `= (…)` and `, (…)` are not.
			if (prev.kind === "punct") {
				return !NO_SPACE_AFTER.has(prev.text) && prev.text !== ")";
			}
			return isKeyword(prev);
		}
		if (token.text === "[") {
			if (prev.kind === "punct") {
				return (
					!NO_SPACE_AFTER.has(prev.text) &&
					prev.text !== ")" &&
					prev.text !== "]"
				);
			}
			// A subscript binds to its name; an array literal follows a word.
			return isKeyword(prev);
		}
		if (NO_SPACE_BEFORE.has(token.text)) {
			return false;
		}
	}
	if (prev.kind === "punct" && NO_SPACE_AFTER.has(prev.text)) {
		return false;
	}
	return true;
}

interface Atom {
	kind: "atom";
	text: string;
	space: boolean;
}

interface CommentPiece {
	kind: "comment";
	text: string;
	space: boolean;
	/** It was on a line of its own in the source, and stays on one. */
	own: boolean;
	/** A `--` comment: nothing may follow it on its line. */
	line: boolean;
}

interface Group {
	kind: "group";
	space: boolean;
	content: Content;
}

interface CaseExpr {
	kind: "case";
	space: boolean;
	/** The CASE keyword, as rendered. */
	keyword: string;
	/** `CASE <expr>` in the simple form; empty in the searched form. */
	head: Piece[];
	/** One per WHEN/ELSE, each starting with its own keyword. */
	branches: Piece[][];
	/** The END keyword, or null when the input never closed the CASE. */
	end: string | null;
}

type Piece = Atom | CommentPiece | Group | CaseExpr;

type Content =
	| { kind: "clauses"; clauses: Clause[] }
	| { kind: "list"; items: Item[] };

interface Item {
	/** How this item was separated from the one before it. */
	separator: "first" | "comma" | "logical";
	/** The AND/OR word, rendered at the start of the line when broken. */
	lead: string;
	pieces: Piece[];
}

interface Clause {
	/** The clause keywords as rendered, or "" for a headless statement. */
	head: string;
	items: Item[];
	indent: number;
	/** A comment that sits on a line of its own between clauses. */
	comment: boolean;
	/** A blank line stood before it — the author's paragraph break. */
	blankBefore: boolean;
}

interface Statement {
	clauses: Clause[];
	/** The input ended it with a semicolon, so the output does too. */
	terminated: boolean;
	/** A blank line separated it from the statement before it. */
	blankBefore: boolean;
	/** A comment that followed the semicolon on the same line. */
	trailer: CommentPiece | null;
}

/**
 * Token stream → clauses, items and nested groups. Returns null when the
 * input defeats the walker (no progress possible), which formatting
 * reads as "leave this document alone".
 */
function parse(
	tokens: Raw[],
	keywordCase: "upper" | "preserve",
): Statement[] | null {
	let pos = 0;
	let prev: Raw | undefined;
	let prev2: Raw | undefined;

	const at = (offset = 0): Raw | undefined => tokens[pos + offset];

	const isWord = (token: Raw | undefined, word: string): boolean =>
		token !== undefined &&
		token.kind === "word" &&
		token.text.toLowerCase() === word;

	const isPunct = (token: Raw | undefined, text: string): boolean =>
		token !== undefined && token.kind === "punct" && token.text === text;

	const isComment = (token: Raw | undefined): boolean =>
		token !== undefined &&
		(token.kind === "lineComment" || token.kind === "blockComment");

	const isBoundary = (token: Raw | undefined): boolean =>
		token === undefined || isPunct(token, ")") || isPunct(token, ";");

	const render = (token: Raw): string =>
		token.kind === "word" &&
		keywordCase === "upper" &&
		KEYWORDS.has(token.text.toLowerCase())
			? token.text.toUpperCase()
			: token.text;

	const consume = (): { token: Raw; space: boolean } => {
		const token = tokens[pos] as Raw;
		const space = needsSpace(prev2, prev, token);
		prev2 = prev;
		prev = token;
		pos++;
		return { token, space };
	};

	/** The clause spec starting here, longest match first. */
	const matchClause = (): ClauseSpec | null => {
		for (const spec of CLAUSES) {
			if (spec.words.every((word, index) => isWord(at(index), word))) {
				return spec;
			}
		}
		return null;
	};

	const commentPiece = (): CommentPiece => {
		const { token, space } = consume();
		return {
			kind: "comment",
			text: token.text,
			space,
			own: token.breaks > 0,
			line: token.kind === "lineComment",
		};
	};

	const parsePiece = (padParen = false): Piece => {
		const token = at() as Raw;
		if (isPunct(token, "(")) {
			return parseGroup(padParen);
		}
		if (isWord(token, "case")) {
			return parseCase();
		}
		if (isComment(token)) {
			return commentPiece();
		}
		const { token: taken, space } = consume();
		return { kind: "atom", text: render(taken), space };
	};

	const parseGroup = (padParen: boolean): Group => {
		const { space } = consume();
		let offset = 0;
		while (isComment(at(offset))) {
			offset++;
		}
		const first = at(offset);
		const query =
			first !== undefined &&
			first.kind === "word" &&
			QUERY_STARTS.has(first.text.toLowerCase());
		const content: Content = query
			? { kind: "clauses", clauses: parseClauses() }
			: { kind: "list", items: parseList() };
		if (isPunct(at(), ")")) {
			consume();
		}
		return { kind: "group", space: padParen || space, content };
	};

	const parseList = (): Item[] => {
		const items: Item[] = [];
		let current: Item = { separator: "first", lead: "", pieces: [] };
		while (!isBoundary(at())) {
			if (isPunct(at(), ",")) {
				consume();
				items.push(current);
				current = { separator: "comma", lead: "", pieces: [] };
				continue;
			}
			current.pieces.push(parsePiece());
		}
		items.push(current);
		return items;
	};

	const parseCase = (): CaseExpr => {
		const { token, space } = consume();
		const branchEnd = (): boolean =>
			isBoundary(at()) ||
			isWord(at(), "when") ||
			isWord(at(), "else") ||
			isWord(at(), "end");
		const head: Piece[] = [];
		while (!branchEnd()) {
			head.push(parsePiece());
		}
		const branches: Piece[][] = [];
		while (isWord(at(), "when") || isWord(at(), "else")) {
			const branch: Piece[] = [parsePiece()];
			while (!branchEnd()) {
				branch.push(parsePiece());
			}
			branches.push(branch);
		}
		return {
			kind: "case",
			space,
			keyword: render(token),
			head,
			branches,
			end: isWord(at(), "end") ? render(consume().token) : null,
		};
	};

	const parseClauses = (): Clause[] => {
		const clauses: Clause[] = [];
		let current: Clause | null = null;
		let spec: ClauseSpec | null = null;
		/** An opaque clause has taken the rest of the statement. */
		let closed = false;
		/** BETWEEN's own AND belongs to the operator, not to the clause. */
		let pendingBetween = false;

		const item = (): Item => {
			const clause = current as Clause;
			return clause.items[clause.items.length - 1] as Item;
		};

		while (!isBoundary(at())) {
			const token = at() as Raw;

			// A comment ahead of the first clause is a header comment; one
			// inside a clause travels with the item it sits on, so the
			// output cannot reorder it past the code it describes.
			if (isComment(token) && current === null) {
				const { token: taken } = consume();
				clauses.push({
					head: taken.text,
					items: [],
					indent: 0,
					comment: true,
					blankBefore: taken.breaks >= 2,
				});
				continue;
			}

			const matched: ClauseSpec | null = closed ? null : matchClause();
			if (matched !== null) {
				spec = matched;
				// A clause word is a keyword by position, so it is cased as
				// one whether or not it is in KEYWORDS — which deliberately
				// leaves out words like `comment` and `values` that are just
				// as often column names.
				const words = matched.words.map(() => {
					const { token: word } = consume();
					return keywordCase === "upper" ? word.text.toUpperCase() : word.text;
				});
				current = {
					head: words.join(" "),
					items: [{ separator: "first", lead: "", pieces: [] }],
					indent: matched.indent ?? 0,
					comment: false,
					blankBefore: token.breaks >= 2,
				};
				pendingBetween = false;
				closed = matched.opaque === true;
				clauses.push(current);
				continue;
			}

			if (current === null) {
				spec = null;
				current = {
					head: "",
					items: [{ separator: "first", lead: "", pieces: [] }],
					indent: 0,
					comment: false,
					blankBefore: token.breaks >= 2,
				};
				clauses.push(current);
			}

			if (isPunct(token, ",")) {
				consume();
				current.items.push({ separator: "comma", lead: "", pieces: [] });
				pendingBetween = false;
				continue;
			}
			// `a, -- why` — a comment straight after the comma was typed on
			// the line above, and stays there rather than displacing the
			// item it now precedes.
			if (
				isComment(token) &&
				token.breaks === 0 &&
				item().pieces.length === 0 &&
				current.items.length > 1
			) {
				const previous = current.items[current.items.length - 2] as Item;
				previous.pieces.push(commentPiece());
				continue;
			}
			if (isWord(token, "and") || isWord(token, "or")) {
				const { token: taken, space } = consume();
				if (pendingBetween) {
					item().pieces.push({ kind: "atom", text: render(taken), space });
					pendingBetween = false;
					continue;
				}
				current.items.push({
					separator: "logical",
					lead: render(taken),
					pieces: [],
				});
				continue;
			}
			if (isWord(token, "between")) {
				pendingBetween = true;
			}
			item().pieces.push(parsePiece(spec?.padParen === true));
		}

		return clauses;
	};

	const statements: Statement[] = [];
	while (pos < tokens.length) {
		const start = pos;
		const blankBefore = (at()?.breaks ?? 0) >= 2;
		const clauses = parseClauses();
		let terminated = false;
		let trailer: CommentPiece | null = null;
		if (isPunct(at(), ";")) {
			consume();
			terminated = true;
			// `SELECT 1; -- note` — the note belongs to the statement it
			// shares a line with, not to the one that follows it.
			const next = at();
			if (isComment(next) && next?.breaks === 0) {
				trailer = commentPiece();
			}
		}
		if (pos === start) {
			// A stray `)` at statement level, or anything else the walker
			// cannot place. Bail rather than guess.
			return null;
		}
		if (clauses.length > 0 || terminated) {
			statements.push({ clauses, terminated, blankBefore, trailer });
		}
	}
	return statements;
}

/** A construct with a comment or a multi-line literal cannot go inline. */
function pieceForcesBreak(piece: Piece): boolean {
	if (piece.kind === "atom") {
		return piece.text.includes("\n");
	}
	if (piece.kind === "comment") {
		return piece.own || piece.line || piece.text.includes("\n");
	}
	if (piece.kind === "case") {
		return (
			forcesBreak(piece.head) ||
			piece.branches.some((branch) => forcesBreak(branch))
		);
	}
	return piece.content.kind === "clauses"
		? piece.content.clauses.some(
				(clause) =>
					clause.comment ||
					clause.items.some((item) => forcesBreak(item.pieces)),
			)
		: piece.content.items.some((item) => forcesBreak(item.pieces));
}

function forcesBreak(pieces: Piece[]): boolean {
	return pieces.some(pieceForcesBreak);
}

function inlinePieces(pieces: Piece[]): string {
	let out = "";
	for (const piece of pieces) {
		let text: string;
		switch (piece.kind) {
			case "group":
				text = `(${
					piece.content.kind === "clauses"
						? inlineClauses(piece.content.clauses)
						: inlineItems(piece.content.items)
				})`;
				break;
			case "case": {
				const parts = [piece.keyword, inlinePieces(piece.head)];
				for (const branch of piece.branches) {
					parts.push(inlinePieces(branch));
				}
				if (piece.end !== null) {
					parts.push(piece.end);
				}
				text = parts.filter((part) => part !== "").join(" ");
				break;
			}
			default:
				text = piece.text;
		}
		out += (piece.space && out !== "" ? " " : "") + text;
	}
	return out;
}

function inlineItems(items: Item[]): string {
	let out = "";
	for (const item of items) {
		const body = inlinePieces(item.pieces);
		if (out === "") {
			out = body;
			continue;
		}
		out +=
			item.separator === "comma"
				? `, ${body}`
				: ` ${item.lead} ${body}`.replace(/ +$/, "");
	}
	return out;
}

function inlineClauses(clauses: Clause[]): string {
	return clauses
		.map((clause) =>
			[clause.head, inlineItems(clause.items)]
				.filter((part) => part !== "")
				.join(" "),
		)
		.filter((line) => line !== "")
		.join(" ");
}

interface Writer {
	newLine: (level: number) => void;
	blankLine: () => void;
	append: (text: string, space: boolean) => void;
	/** A `--` comment closed the line; the next append starts a new one. */
	seal: () => void;
	width: () => number;
	text: () => string;
}

function createWriter(indentUnit: string): Writer {
	const lines: string[] = [];
	let current: string | null = null;
	let level = 0;
	let sealed = false;

	const trim = (line: string): string => line.replace(/\s+$/, "");

	const newLine = (nextLevel: number): void => {
		// A line nothing was written to is not a line: an own-line comment,
		// or a group that breaks at the start of an item, must not leave a
		// blank behind it.
		if (current !== null && current.trim() !== "") {
			lines.push(trim(current));
		}
		level = nextLevel;
		current = indentUnit.repeat(nextLevel);
		sealed = false;
	};

	return {
		newLine,
		blankLine: () => {
			if (current !== null && current.trim() !== "") {
				lines.push(trim(current));
			}
			current = null;
			lines.push("");
		},
		append: (text, space) => {
			if (sealed) {
				newLine(level);
			}
			const line = current ?? "";
			current = line + (space && line.trim() !== "" ? " " : "") + text;
		},
		seal: () => {
			sealed = true;
		},
		width: () => (current ?? "").length,
		text: () =>
			(current !== null && current.trim() !== ""
				? [...lines, trim(current)]
				: lines
			).join("\n"),
	};
}

interface RenderContext {
	writer: Writer;
	maxWidth: number;
}

function renderPieces(
	pieces: Piece[],
	level: number,
	context: RenderContext,
): void {
	const { writer, maxWidth } = context;
	const fits = (run: Piece[]): boolean => {
		const first = run[0];
		return (
			first !== undefined &&
			writer.width() + inlinePieces(run).length + (first.space ? 1 : 0) <=
				maxWidth
		);
	};
	let index = 0;
	while (index < pieces.length) {
		const rest = pieces.slice(index);
		const first = rest[0] as Piece;
		// The whole remainder of the item is measured, not just this
		// piece: `) AS x` has to fit too, or the paren breaks for nothing.
		if (!forcesBreak(rest) && fits(rest)) {
			writer.append(inlinePieces(rest), first.space);
			return;
		}
		// A later piece that must break — a comment, a multi-line literal
		// — is no reason to break the pieces ahead of it: the run up to it
		// goes inline if it fits, so `f(x int) AS $$…` keeps its arguments.
		let stop = index;
		while (stop < pieces.length && !pieceForcesBreak(pieces[stop] as Piece)) {
			stop++;
		}
		const run = pieces.slice(index, stop);
		if (run.length > 0 && fits(run)) {
			writer.append(inlinePieces(run), first.space);
			index = stop;
			continue;
		}
		index++;
		switch (first.kind) {
			case "atom":
				writer.append(first.text, first.space);
				break;
			case "comment":
				if (first.own) {
					writer.newLine(level);
				}
				writer.append(first.text, first.space);
				if (first.line) {
					writer.seal();
				}
				break;
			case "group":
				writer.append("(", first.space);
				if (first.content.kind === "clauses") {
					renderClauses(first.content.clauses, level + 1, context);
				} else {
					renderList(first.content.items, level + 1, context);
				}
				writer.newLine(level);
				writer.append(")", false);
				break;
			case "case":
				writer.append(first.keyword, first.space);
				renderPieces(first.head, level + 1, context);
				for (const branch of first.branches) {
					writer.newLine(level + 1);
					renderPieces(branch, level + 1, context);
				}
				if (first.end !== null) {
					writer.newLine(level);
					writer.append(first.end, false);
				}
				break;
		}
	}
}

/**
 * One item, plus the separator that follows it. The comma goes before a
 * trailing `--` comment, never after it, or the comma would end up
 * commented out.
 */
function renderItem(
	item: Item,
	level: number,
	context: RenderContext,
	trailer: string,
): void {
	const { writer } = context;
	const pieces = [...item.pieces];
	const last = pieces[pieces.length - 1];
	const trailing =
		last !== undefined && last.kind === "comment" && !last.own
			? (pieces.pop() as CommentPiece)
			: undefined;
	if (item.separator === "logical") {
		writer.append(item.lead, false);
	}
	renderPieces(pieces, level, context);
	if (trailer !== "") {
		writer.append(trailer, false);
	}
	if (trailing !== undefined) {
		writer.append(trailing.text, true);
		if (trailing.line) {
			writer.seal();
		}
	}
}

function renderList(
	items: Item[],
	level: number,
	context: RenderContext,
): void {
	for (const [index, item] of items.entries()) {
		context.writer.newLine(level);
		renderItem(item, level, context, index < items.length - 1 ? "," : "");
	}
}

function renderItems(
	items: Item[],
	level: number,
	context: RenderContext,
): void {
	const { writer, maxWidth } = context;
	const inline = inlineItems(items);
	if (inline === "") {
		return;
	}
	const forced = items.some((item) => forcesBreak(item.pieces));
	if (!forced && writer.width() + inline.length + 1 <= maxWidth) {
		writer.append(inline, true);
		return;
	}
	// A lone item stays on the clause's line and breaks inside itself:
	// `FROM (` reads better than a `FROM` on a line of its own.
	if (items.length === 1) {
		renderItem(items[0] as Item, level, context, "");
		return;
	}
	for (const [index, item] of items.entries()) {
		writer.newLine(level + 1);
		const next = items[index + 1];
		renderItem(
			item,
			level + 1,
			context,
			next !== undefined && next.separator === "comma" ? "," : "",
		);
	}
}

function renderClauses(
	clauses: Clause[],
	level: number,
	context: RenderContext,
): void {
	for (const [index, clause] of clauses.entries()) {
		const { writer } = context;
		// A blank line the author left between clauses is a paragraph
		// break, so it survives; before the first clause it is the
		// statement separator, which the caller has already written.
		if (index > 0 && clause.blankBefore) {
			writer.blankLine();
		}
		writer.newLine(level + clause.indent);
		if (clause.comment) {
			writer.append(clause.head, false);
			if (clause.head.startsWith("--")) {
				writer.seal();
			}
			continue;
		}
		if (clause.head !== "") {
			writer.append(clause.head, false);
		}
		renderItems(clause.items, level + clause.indent, context);
	}
}

/** Tokens as compared before and after: only keyword case may differ. */
function signature(tokens: Raw[]): string {
	return tokens
		.map((token) =>
			token.kind === "word"
				? `w:${token.text.toLowerCase()}`
				: `${token.kind}:${token.text}`,
		)
		.join(" ");
}

/**
 * Reformat SQL. Returns the input unchanged when it holds no tokens, or
 * when the result would not tokenize back to the same statement.
 */
export function formatSql(sql: string, options: FormatOptions = {}): string {
	const splitOptions = splitOptionsForDialect(options.dialect ?? "postgres");
	const tokens = tokenize(sql, splitOptions);
	if (tokens.length === 0) {
		return sql;
	}
	const statements = parse(tokens, options.keywordCase ?? "upper");
	if (statements === null || statements.length === 0) {
		return sql;
	}
	const writer = createWriter(options.indent ?? DEFAULT_INDENT);
	const context: RenderContext = {
		writer,
		maxWidth: options.maxWidth ?? DEFAULT_MAX_WIDTH,
	};
	for (const [index, statement] of statements.entries()) {
		if (index > 0 && statement.blankBefore) {
			writer.blankLine();
		}
		renderClauses(statement.clauses, 0, context);
		if (statement.terminated) {
			writer.append(";", false);
		}
		if (statement.trailer !== null) {
			writer.append(statement.trailer.text, true);
			if (statement.trailer.line) {
				writer.seal();
			}
		}
	}
	const formatted = writer.text();
	if (signature(tokenize(formatted, splitOptions)) !== signature(tokens)) {
		return sql;
	}
	return sql.endsWith("\n") ? `${formatted}\n` : formatted;
}
