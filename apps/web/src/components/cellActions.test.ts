import { describe, expect, test } from "bun:test";
import type { TableColumn } from "@datagripe/contracts";
import {
	canSetDefault,
	cellLanguage,
	filterPredicate,
	isJsonType,
	looksLikeJson,
	quoteIdentifier,
	rowTsv,
} from "./cellActions";

/**
 * The cell menu's decisions (docs/spec/table-view.md "The cell menu").
 * Two of them can be wrong in ways the UI would not show: the language
 * the value editor opens in, and the SQL "filter by this value" writes.
 */

function column(overrides: Partial<TableColumn> = {}): TableColumn {
	return {
		name: "payload",
		dataType: "jsonb",
		nullable: true,
		primaryKey: false,
		generated: false,
		hasDefault: false,
		...overrides,
	};
}

describe("isJsonType", () => {
	test("the JSON column types, however they are cased", () => {
		expect(isJsonType("json")).toBe(true);
		expect(isJsonType("jsonb")).toBe(true);
		expect(isJsonType(" JSONB ")).toBe(true);
		expect(isJsonType("jsonb[]")).toBe(true);
	});

	test("not text, and not a type that merely contains the word", () => {
		expect(isJsonType("text")).toBe(false);
		expect(isJsonType("json_payload")).toBe(false);
	});
});

describe("looksLikeJson", () => {
	test("objects and arrays that parse", () => {
		expect(looksLikeJson('{"a":1}')).toBe(true);
		expect(looksLikeJson("  [1, 2] ")).toBe(true);
	});

	test("a bare scalar is not worth JSON mode", () => {
		expect(looksLikeJson("42")).toBe(false);
		expect(looksLikeJson('"a string"')).toBe(false);
	});

	test("a document that does not parse", () => {
		expect(looksLikeJson('{"a":')).toBe(false);
	});
});

describe("cellLanguage", () => {
	test("a jsonb column stays JSON even while the text is broken", () => {
		// This is the point of the squiggles: mid-edit text is still JSON.
		expect(cellLanguage("jsonb", '{"a":')).toBe("json");
	});

	test("a JSON document in a text column gets JSON anyway", () => {
		expect(cellLanguage("text", '{"a":1}')).toBe("json");
	});

	test("plain text, and an unknown column type", () => {
		expect(cellLanguage("text", "hello")).toBe("plaintext");
		expect(cellLanguage(undefined, "hello")).toBe("plaintext");
		expect(cellLanguage(undefined, "[1]")).toBe("json");
	});
});

describe("quoteIdentifier", () => {
	test("per dialect, with the quote character doubled", () => {
		expect(quoteIdentifier("postgres", 'we"ird')).toBe('"we""ird"');
		expect(quoteIdentifier("mysql", "we`ird")).toBe("`we``ird`");
		expect(quoteIdentifier("sqlite", "plain")).toBe('"plain"');
	});
});

describe("filterPredicate", () => {
	test("NULL is IS NULL, never = NULL", () => {
		expect(filterPredicate("postgres", "status", null)).toBe(
			'"status" IS NULL',
		);
	});

	test("numbers and booleans are unquoted literals", () => {
		expect(filterPredicate("postgres", "amount", 42)).toBe('"amount" = 42');
		expect(filterPredicate("mysql", "paid", true)).toBe("`paid` = true");
	});

	test("text is a single-quoted literal with its quotes doubled", () => {
		expect(filterPredicate("postgres", "name", "O'Hara")).toBe(
			"\"name\" = 'O''Hara'",
		);
	});

	test("a quote-stuffed value cannot end the literal early", () => {
		const predicate = filterPredicate("postgres", "name", "'; drop table t--");
		expect(predicate).toBe("\"name\" = '''; drop table t--'");
		// Every apostrophe inside the literal is doubled, so the literal is
		// still one literal: an odd count would mean it had been closed.
		const inner = predicate.slice(predicate.indexOf("'") + 1, -1);
		expect(inner.split("").filter((char) => char === "'").length % 2).toBe(0);
	});

	test("an object value is compared as its JSON text", () => {
		expect(filterPredicate("postgres", "payload", { a: 1 })).toBe(
			'"payload" = \'{"a":1}\'',
		);
	});
});

describe("rowTsv", () => {
	test("values only, with tabs and newlines flattened", () => {
		expect(rowTsv([1, null, "a\tb", "c\nd", { a: 1 }])).toBe(
			'1\t\ta b\tc d\t{"a":1}',
		);
	});
});

describe("canSetDefault", () => {
	test("a draft insert row can always default a writable column", () => {
		expect(canSetDefault("mysql", column(), true)).toBe(true);
		expect(canSetDefault("sqlite", column(), true)).toBe(true);
	});

	test("only postgres can set a column back to DEFAULT in an update", () => {
		const withDefault = column({ hasDefault: true });
		expect(canSetDefault("postgres", withDefault, false)).toBe(true);
		expect(canSetDefault("mysql", withDefault, false)).toBe(false);
		expect(canSetDefault("sqlite", withDefault, false)).toBe(false);
	});

	test("a column with no default has nothing to fall back to", () => {
		expect(canSetDefault("postgres", column(), false)).toBe(false);
	});

	test("a generated column is never writable", () => {
		expect(canSetDefault("postgres", column({ generated: true }), true)).toBe(
			false,
		);
	});
});
