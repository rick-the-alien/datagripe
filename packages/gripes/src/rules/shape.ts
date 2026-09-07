import type { SqlToken } from "@datagripe/sql-tools";

/**
 * Shared statement shape helpers for the rule catalogue
 * (docs/spec/gripes.md). Small, boring, and heavily reused — the point
 * is that each rule expresses only what makes *it* different.
 */

/** Words that end a statement's main clause list. */
const TAIL = new Set(["returning", "union", "intersect", "except"]);

const VERBS = new Set([
	"select",
	"insert",
	"update",
	"delete",
	"merge",
	"truncate",
	"create",
	"alter",
	"drop",
	"grant",
	"revoke",
	"with",
	"explain",
	"copy",
	"call",
	"do",
]);

/**
 * The statement's main verb, looking through a leading `WITH` clause.
 *
 * This is what stops `create trigger t after delete on x` from reading
 * as a delete: the verb is `create`, and the `delete` is an event name.
 * A rule that skipped this would fire on every trigger definition,
 * which is precisely the wrong gripe.
 */
export function leadingVerb(tokens: SqlToken[]): string | undefined {
	let index = 0;
	while (index < tokens.length) {
		const token = tokens[index] as SqlToken;
		if (token.kind !== "word" || token.quoted) {
			index += 1;
			continue;
		}
		if (token.text !== "with") {
			return VERBS.has(token.text) ? token.text : undefined;
		}
		// A CTE body sits inside parentheses, so the real verb is the next
		// depth-0 verb after them.
		for (let i = index + 1; i < tokens.length; i++) {
			const candidate = tokens[i] as SqlToken;
			if (
				candidate.kind === "word" &&
				!candidate.quoted &&
				candidate.depth === 0 &&
				candidate.text !== "recursive" &&
				candidate.text !== "as" &&
				VERBS.has(candidate.text)
			) {
				return candidate.text;
			}
		}
		return undefined;
	}
	return undefined;
}

/** The index of the first depth-0 occurrence of a word, or -1. */
export function indexOfKeyword(
	tokens: SqlToken[],
	word: string,
	from = 0,
): number {
	for (let i = from; i < tokens.length; i++) {
		const token = tokens[i] as SqlToken;
		if (
			token.kind === "word" &&
			!token.quoted &&
			token.depth === 0 &&
			token.text === word
		) {
			return i;
		}
	}
	return -1;
}

/**
 * Whether the statement's main clause has a `WHERE` — at depth 0, so a
 * subquery's `WHERE` does not count as qualifying the outer statement.
 */
export function hasTopLevelWhere(tokens: SqlToken[], from = 0): boolean {
	for (let i = from; i < tokens.length; i++) {
		const token = tokens[i] as SqlToken;
		if (token.kind !== "word" || token.quoted || token.depth !== 0) {
			continue;
		}
		if (token.text === "where") {
			return true;
		}
		if (TAIL.has(token.text)) {
			return false;
		}
	}
	return false;
}

/** The word tokens of a statement, lower-cased, quoted ones excluded. */
export function keywords(tokens: SqlToken[]): string[] {
	return tokens
		.filter((token) => token.kind === "word" && !token.quoted)
		.map((token) => token.text);
}

/**
 * Whether the `*` at this index is a projection star rather than
 * multiplication.
 *
 * `select a * 2 from t` has a `*` punct token sitting at the same depth
 * as a real star, and the only thing distinguishing them is what
 * surrounds it: a star is preceded by `select`, a comma or the `.` of a
 * table qualifier, and followed by a comma or `from`. Multiplication
 * has an operand on both sides. Without this a rule about `select *`
 * fires on arithmetic, which is the kind of wrong gripe that gets the
 * whole feature switched off.
 */
export function isProjectionStar(tokens: SqlToken[], index: number): boolean {
	const star = tokens[index];
	if (star === undefined || star.kind !== "punct" || star.text !== "*") {
		return false;
	}
	const before = tokens[index - 1];
	const after = tokens[index + 1];
	if (before === undefined || after === undefined) {
		return false;
	}
	const leads =
		(before.kind === "word" && !before.quoted && before.text === "select") ||
		(before.kind === "punct" && (before.text === "," || before.text === "."));
	const trails =
		(after.kind === "word" && !after.quoted && after.text === "from") ||
		(after.kind === "punct" && (after.text === "," || after.text === ";"));
	return leads && trails;
}
