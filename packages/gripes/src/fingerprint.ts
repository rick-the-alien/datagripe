/**
 * A stable key for "this finding, here" (docs/spec/gripes.md
 * "Dismissal").
 *
 * An occurrence dismissal cannot key on a document offset: offsets move
 * as soon as anything above them is typed, so the dismissal would
 * evaporate on the next keystroke. It keys on the statement's text
 * instead, which means editing an unrelated statement keeps the
 * dismissal, and editing *this* statement drops it — correct, because
 * the finding may no longer hold once the text changed.
 *
 * This is a dedup key, not a security boundary, so FNV-1a is plenty and
 * a crypto hash would only cost bytes.
 */

/** Whitespace and case are not meaning; reformatting must not un-dismiss. */
export function normalizeStatement(text: string): string {
	return text.replaceAll(/\s+/g, " ").trim().toLowerCase();
}

export function statementFingerprint(text: string): string {
	const normalized = normalizeStatement(text);
	let hash = 0x811c9dc5;
	for (let i = 0; i < normalized.length; i++) {
		hash ^= normalized.charCodeAt(i);
		// FNV prime, kept in 32 bits by Math.imul.
		hash = Math.imul(hash, 0x01000193);
	}
	// Unsigned hex, so the key is stable and printable.
	return (hash >>> 0).toString(16).padStart(8, "0");
}
