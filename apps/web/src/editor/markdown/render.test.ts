import { describe, expect, test } from "bun:test";
import { isExternalLink, renderMarkdown } from "./render";

/**
 * Markdown rendering (docs/spec/markdown-documents.md "Rendering").
 *
 * The first describe block is the one that matters. `MarkdownView` puts
 * this output through `dangerouslySetInnerHTML`, and the reason that is
 * defensible is that raw HTML is **escaped by the parser** rather than
 * filtered out afterwards — escaping has no bypass to find. These
 * assertions are what makes that claim checkable.
 */

describe("raw HTML is escaped, never passed through", () => {
	test("a script tag renders as text", () => {
		const html = renderMarkdown("Hi <script>alert(1)</script> there");
		expect(html).not.toContain("<script");
		expect(html).toContain("&lt;script&gt;");
	});

	test("an event handler on an img renders as text", () => {
		const html = renderMarkdown('<img src=x onerror="alert(1)">');
		expect(html).not.toContain("<img");
		expect(html).not.toContain('onerror="');
		expect(html).toContain("&lt;img");
	});

	test("a block-level iframe renders as text", () => {
		const html = renderMarkdown("\n<iframe src=//evil></iframe>\n");
		expect(html).not.toContain("<iframe");
		expect(html).toContain("&lt;iframe");
	});

	test("inline HTML inside a paragraph renders as text", () => {
		const html = renderMarkdown("some <b>bold</b> words");
		expect(html).toContain("&lt;b&gt;bold&lt;/b&gt;");
	});

	test("a javascript: link is not turned into an anchor DataGripe follows", () => {
		// It is external by our test, so it gets `target=_blank` and
		// `rel=noreferrer noopener` — and no `data-dg-path`, so the pane
		// never treats it as a file to open.
		const html = renderMarkdown("[x](javascript:alert(1))");
		expect(html).not.toContain("data-dg-path");
	});
});

describe("links", () => {
	test("an external link opens in a new tab, with rel", () => {
		const html = renderMarkdown("[docs](https://example.com/a)");
		expect(html).toContain('href="https://example.com/a"');
		expect(html).toContain('target="_blank"');
		expect(html).toContain('rel="noreferrer noopener"');
	});

	test("a relative link carries its path and no navigable href", () => {
		// The pane intercepts the click and opens the file; the renderer
		// deliberately leaves no href the browser would follow.
		const html = renderMarkdown("[the query](./churn.sql)");
		expect(html).toContain('data-dg-path="./churn.sql"');
		expect(html).toContain('href="#"');
		expect(html).not.toContain("target=");
	});

	test("isExternalLink knows a scheme from a path", () => {
		expect(isExternalLink("https://x")).toBe(true);
		expect(isExternalLink("mailto:a@b")).toBe(true);
		expect(isExternalLink("//cdn/x")).toBe(true);
		expect(isExternalLink("./a.sql")).toBe(false);
		expect(isExternalLink("docs/a.md")).toBe(false);
	});
});

describe("other markdown", () => {
	test("an image is described, not fetched", () => {
		// A remote image is a beacon and a relative one is a file the
		// server would have to serve.
		const html = renderMarkdown("![a diagram](plan.png)");
		expect(html).not.toContain("<img");
		expect(html).toContain("a diagram");
		expect(html).toContain("plan.png");
	});

	test("gfm tables render", () => {
		const html = renderMarkdown("| a | b |\n|---|---|\n| 1 | 2 |");
		expect(html).toContain("<table>");
		expect(html).toContain("<td>1</td>");
	});

	test("a non-sql fence is plain, escaped, monospaced code", () => {
		const html = renderMarkdown("```bash\necho '<b>' \n```");
		expect(html).toContain("dg-md-code");
		expect(html).toContain("&lt;b&gt;");
		expect(html).toContain("bash");
	});
});
