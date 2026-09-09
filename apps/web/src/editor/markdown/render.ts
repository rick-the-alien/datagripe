import { Marked } from "marked";

/**
 * Markdown → HTML (docs/spec/markdown-documents.md "Rendering").
 *
 * The rule that matters: **raw HTML is escaped, not sanitized.** A
 * `<script>` in the file renders as the text `<script>`. Escaping is a
 * property of the parser configuration; sanitizing is a filter somebody
 * has to keep ahead of an attacker, and the first one has no bypass to
 * find. A file from a checkout is content a teammate may have written.
 *
 * SQL fences never reach this module — the pane splits them out with
 * `scanMarkdown` first and renders each run of prose separately, so a
 * runnable block is a real Monaco instance rather than a `<pre>`.
 */

/**
 * The image mark, inlined.
 *
 * This module hands Monaco a string, so it cannot render the React icon
 * from `components/icons.tsx`. Same family (Lucide `image`, ISC), same
 * 1.5 stroke — if the family changes, this changes with it.
 */
const IMAGE_ICON =
	'<svg class="dg-icon" width="14" height="14" viewBox="0 0 24 24" fill="none" ' +
	'stroke="currentColor" stroke-width="1.5" stroke-linecap="round" ' +
	'stroke-linejoin="round" aria-hidden="true">' +
	'<rect width="18" height="18" x="3" y="3" rx="2" ry="2"/>' +
	'<circle cx="9" cy="9" r="2"/>' +
	'<path d="m21 15-3.086-3.086a2 2 0 0 0-2.828 0L6 21"/>' +
	"</svg>";

function escapeHtml(value: string): string {
	return value
		.replaceAll("&", "&amp;")
		.replaceAll("<", "&lt;")
		.replaceAll(">", "&gt;")
		.replaceAll('"', "&quot;");
}

/** A link that leaves DataGripe, as opposed to one into the checkout. */
export function isExternalLink(href: string): boolean {
	return /^[a-z][a-z0-9+.-]*:/i.test(href) || href.startsWith("//");
}

/**
 * A fresh instance rather than the global `marked`: the table view and
 * anything else that ever wants a differently-configured parser should
 * not have to fight this one's renderer overrides.
 */
const renderer = new Marked({
	gfm: true,
	breaks: false,
});

renderer.use({
	renderer: {
		html(token) {
			// Both block and inline HTML arrive here.
			const raw =
				typeof token === "string" ? token : (token.raw ?? token.text ?? "");
			return escapeHtml(raw);
		},
		link(token) {
			const href = token.href ?? "";
			const title =
				token.title === null || token.title === undefined
					? ""
					: ` title="${escapeHtml(token.title)}"`;
			if (isExternalLink(href)) {
				// `noreferrer noopener` on every one: a runbook is not a place
				// to be careful about which links got the attribute.
				return `<a href="${escapeHtml(href)}" target="_blank" rel="noreferrer noopener"${title}>${token.text}</a>`;
			}
			// A relative link is a file in the checkout. The pane intercepts
			// the click and opens it, so this carries the path and no href
			// the browser would try to navigate to.
			return `<a href="#" data-dg-path="${escapeHtml(href)}"${title}>${token.text}</a>`;
		},
		image(token) {
			// Not fetched: a remote image is a beacon and a relative one is a
			// file the server would have to serve. Both render as their text
			// with the source beside it.
			const href = escapeHtml(token.href ?? "");
			const text = escapeHtml(token.text ?? "image");
			return `<span class="dg-md-image">${IMAGE_ICON} ${text} <code>${href}</code></span>`;
		},
		code(token) {
			// Non-SQL fences: monospaced and unstyled. Highlighting eleven
			// languages is a different project.
			const info = (token.lang ?? "").trim();
			const label =
				info === ""
					? ""
					: `<span class="dg-md-code-lang">${escapeHtml(info)}</span>`;
			return `<pre class="dg-md-code">${label}<code>${escapeHtml(token.text ?? "")}</code></pre>`;
		},
	},
});

export function renderMarkdown(source: string): string {
	return renderer.parse(source, { async: false });
}
