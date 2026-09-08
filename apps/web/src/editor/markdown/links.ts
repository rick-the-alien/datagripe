/**
 * Resolving a relative link in a runbook against the file it was
 * written in (docs/spec/markdown-documents.md "Rendering").
 *
 * Pure, and refusing rather than clamping. A link that climbs out of the
 * configured path is inert here, which means no request goes out at all
 * — the server's `resolveInside` would refuse it anyway, and two refusals
 * are cheaper than one round trip that ends in a red banner.
 */

/** Strip a `#fragment` and a `?query`: neither means anything to a file. */
function bare(href: string): string {
	return href.split("#")[0]?.split("?")[0] ?? "";
}

/**
 * The path a link points at, relative to the same root as `from`, or
 * null when it is not a file this can reach.
 */
export function resolveRelativeFile(from: string, href: string): string | null {
	const target = bare(href.trim());
	if (
		target === "" ||
		target.startsWith("/") ||
		/^[a-z][a-z0-9+.-]*:/i.test(target)
	) {
		return null;
	}
	// The link is written relative to the *directory* of the document.
	const segments = from.split("/").slice(0, -1);
	for (const part of target.split("/")) {
		if (part === "" || part === ".") {
			continue;
		}
		if (part === "..") {
			// Refuse rather than clamping at the root: clamping would open a
			// different file from the one the link named.
			if (segments.length === 0) {
				return null;
			}
			segments.pop();
			continue;
		}
		segments.push(part);
	}
	return segments.length === 0 ? null : segments.join("/");
}
