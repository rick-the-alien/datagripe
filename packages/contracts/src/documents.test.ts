import { describe, expect, test } from "bun:test";
import { languageForName } from "./documents";

/**
 * The one language rule (docs/spec/markdown-documents.md "Where a
 * language comes from").
 *
 * It lives in contracts because the server applies it on save and the
 * client applies it on the way into the sidebar, and the two disagreeing
 * would mean a runbook that renders in one place and highlights as SQL
 * in the other.
 */

describe("languageForName", () => {
	test("markdown extensions, case-insensitively", () => {
		for (const name of [
			"maintenance.md",
			"README.MD",
			"notes.Markdown",
			"docs/runbooks/nightly.md",
		]) {
			expect(languageForName(name)).toBe("markdown");
		}
	});

	test("everything else is sql", () => {
		for (const name of [
			"blah.sql",
			"query22.SQL",
			"notes",
			"analysis.json",
			// The extension is the *last* one: `a.md.sql` is a SQL file
			// somebody named oddly, not a markdown file.
			"a.md.sql",
			"weird.mdx",
		]) {
			expect(languageForName(name)).toBe("sql");
		}
	});

	test("a name that is only an extension still resolves", () => {
		expect(languageForName(".md")).toBe("markdown");
		expect(languageForName("")).toBe("sql");
	});
});
