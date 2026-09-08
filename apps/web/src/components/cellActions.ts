import type { AdapterDialect, TableColumn } from "@datagripe/contracts";

/**
 * Decisions behind the table view's cell context menu and value editor
 * (docs/spec/table-view.md). Kept out of the components so the parts
 * that can be wrong — which language the value editor opens in, and what
 * "filter by this value" splices into the `where …` box — are testable
 * without a DOM or a Monaco instance.
 */

/** Column types whose values are JSON documents, per engine. */
const JSON_TYPES = new Set([
	"json",
	"jsonb",
	"json[]",
	"jsonb[]",
	// SQLite has no JSON type; a JSON1 column is declared TEXT and gets
	// caught by the value sniff below instead.
]);

export function isJsonType(dataType: string): boolean {
	return JSON_TYPES.has(dataType.trim().toLowerCase());
}

/**
 * The language the value editor opens a cell in. The declared type wins
 * — a `jsonb` column stays JSON even while its draft is mid-edit and
 * momentarily unparseable, which is the whole point of showing
 * squiggles. Otherwise the text is sniffed, so a JSON document living in
 * a `text` column still gets the JSON treatment.
 */
export function cellLanguage(
	dataType: string | undefined,
	text: string,
): "json" | "plaintext" {
	if (dataType !== undefined && isJsonType(dataType)) {
		return "json";
	}
	return looksLikeJson(text) ? "json" : "plaintext";
}

/** True when the text is a JSON object or array — not a bare scalar. */
export function looksLikeJson(text: string): boolean {
	const trimmed = text.trim();
	const opens = trimmed.startsWith("{") || trimmed.startsWith("[");
	if (!opens) {
		return false;
	}
	try {
		JSON.parse(trimmed);
		return true;
	} catch {
		return false;
	}
}

const IDENTIFIER_QUOTES: Record<AdapterDialect, string> = {
	postgres: '"',
	mysql: "`",
	sqlite: '"',
};

/** An identifier, quoted for the dialect with the quote char doubled. */
export function quoteIdentifier(dialect: AdapterDialect, name: string): string {
	const quote = IDENTIFIER_QUOTES[dialect];
	return `${quote}${name.replaceAll(quote, quote + quote)}${quote}`;
}

/**
 * The predicate "filter by this value" puts in the `where …` box.
 *
 * The box takes raw SQL, so this is the one menu item that writes SQL on
 * the user's behalf: the identifier is quoted per dialect and the value
 * becomes a single-quoted literal with its quotes doubled, which is also
 * what stops a value containing `'` from ending the literal early. The
 * server re-checks the whole box with the statement splitter regardless
 * (docs/spec/table-view.md "Safety") — this is convenience, not the
 * security boundary.
 */
export function filterPredicate(
	dialect: AdapterDialect,
	column: string,
	value: unknown,
): string {
	const identifier = quoteIdentifier(dialect, column);
	if (value === null || value === undefined) {
		return `${identifier} IS NULL`;
	}
	const text =
		typeof value === "object" ? JSON.stringify(value) : String(value);
	if (typeof value === "number" || typeof value === "boolean") {
		return `${identifier} = ${text}`;
	}
	return `${identifier} = '${text.replaceAll("'", "''")}'`;
}

/** One row as tab-separated values, for "copy row". */
export function rowTsv(row: readonly unknown[]): string {
	return row
		.map((value) => {
			if (value === null || value === undefined) {
				return "";
			}
			const text =
				typeof value === "object" ? JSON.stringify(value) : String(value);
			return text.replaceAll("\t", " ").replaceAll("\n", " ");
		})
		.join("\t");
}

/**
 * Whether a column can take a `DEFAULT` on this engine. Postgres can
 * `SET col = DEFAULT` in an UPDATE; MySQL and SQLite reject it, so on
 * those the menu item is only honest on a draft insert row, where
 * "default" means "omit the column" (docs/spec/table-view.md
 * "Capabilities").
 */
export function canSetDefault(
	dialect: AdapterDialect | null,
	column: TableColumn,
	isInsert: boolean,
): boolean {
	if (column.generated) {
		return false;
	}
	if (isInsert) {
		return true;
	}
	return dialect === "postgres" && column.hasDefault;
}
