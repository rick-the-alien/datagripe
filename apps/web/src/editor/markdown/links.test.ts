import { describe, expect, test } from "bun:test";
import { resolveRelativeFile } from "./links";

/**
 * Relative links in a runbook (docs/spec/markdown-documents.md
 * "Rendering").
 *
 * The rule worth asserting is the refusal: a link that climbs out of its
 * path is **inert**, not clamped. Clamping would open a different file
 * from the one the link named, which is the worst of the three possible
 * behaviours.
 */

describe("resolveRelativeFile", () => {
	test("resolves against the document's directory, not the root", () => {
		expect(resolveRelativeFile("docs/runbooks/nightly.md", "./churn.sql")).toBe(
			"docs/runbooks/churn.sql",
		);
		expect(resolveRelativeFile("docs/runbooks/nightly.md", "churn.sql")).toBe(
			"docs/runbooks/churn.sql",
		);
	});

	test("a single `..` steps up one directory", () => {
		expect(resolveRelativeFile("docs/runbooks/nightly.md", "../a.sql")).toBe(
			"docs/a.sql",
		);
	});

	test("climbing past the root is inert, never clamped", () => {
		expect(
			resolveRelativeFile("docs/nightly.md", "../../etc/passwd"),
		).toBeNull();
		expect(resolveRelativeFile("nightly.md", "../a.sql")).toBeNull();
	});

	test("an absolute path or a scheme is not a file link", () => {
		for (const href of [
			"/etc/passwd",
			"https://example.com",
			"mailto:a@b",
			"javascript:alert(1)",
		]) {
			expect(resolveRelativeFile("a/b.md", href)).toBeNull();
		}
	});

	test("a fragment or query is stripped", () => {
		expect(resolveRelativeFile("a/b.md", "./c.sql#L4")).toBe("a/c.sql");
		expect(resolveRelativeFile("a/b.md", "./c.sql?x=1")).toBe("a/c.sql");
	});

	test("a bare fragment points at nothing", () => {
		// There is no URL to link to, so a heading anchor is not a file.
		expect(resolveRelativeFile("a/b.md", "#heading")).toBeNull();
		expect(resolveRelativeFile("a/b.md", "")).toBeNull();
	});
});
