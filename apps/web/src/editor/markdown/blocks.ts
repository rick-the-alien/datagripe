/**
 * Finding the fenced code blocks in a markdown document
 * (docs/spec/markdown-documents.md "SQL blocks").
 *
 * One scanner, three consumers: the renderer replaces `sql` fences with
 * runnable blocks, the gripes runner analyses their contents at document
 * offsets, and the editor's completion and formatting providers use it
 * to decide whether the caret is somewhere the SQL features apply.
 *
 * Pure, and deliberately so — every one of those three has to agree
 * about where a block starts, and the cheapest way to guarantee that is
 * for there to be one function.
 */

/** Info strings that make a fence runnable. Case-insensitive. */
const SQL_INFO = new Set(["sql", "postgres", "postgresql", "mysql", "sqlite"]);

export interface MarkdownSegment {
	kind: "prose" | "code";
	/** The fence's info string, lowercased and trimmed. "" for prose. */
	info: string;
	/** True for a code fence DataGripe will run. */
	sql: boolean;
	/** Offset of the segment's *content* in the whole document. */
	start: number;
	/** Offset one past the content's last character. */
	end: number;
	/** The content itself: for a fence, the lines between the delimiters. */
	text: string;
}

const FENCE = /^(\s{0,3})(`{3,}|~{3,})(.*)$/;

/**
 * Split a document into prose runs and fenced code blocks.
 *
 * An unterminated fence at end of file is a block that runs to the end,
 * not an error and not a reason to give up on the rest of the document:
 * somebody is mid-typing, and the pane should not blank out while they
 * are.
 */
export function scanMarkdown(source: string): MarkdownSegment[] {
	const segments: MarkdownSegment[] = [];
	const lines = source.split("\n");
	// Offset of the first character of `lines[index]`.
	const offsets: number[] = [];
	let running = 0;
	for (const line of lines) {
		offsets.push(running);
		running += line.length + 1;
	}

	let proseStart = 0;
	let index = 0;

	const flushProse = (until: number): void => {
		if (until <= proseStart) {
			return;
		}
		segments.push({
			kind: "prose",
			info: "",
			sql: false,
			start: proseStart,
			end: until,
			text: source.slice(proseStart, until),
		});
	};

	while (index < lines.length) {
		const line = lines[index] ?? "";
		const opening = FENCE.exec(line);
		if (opening === null) {
			index += 1;
			continue;
		}
		const marker = opening[2] ?? "";
		const info = (opening[3] ?? "").trim().toLowerCase();
		const openOffset = offsets[index] ?? 0;
		flushProse(openOffset);

		const contentStart = openOffset + line.length + 1;
		let close = index + 1;
		while (close < lines.length) {
			const candidate = FENCE.exec(lines[close] ?? "");
			// A closing fence is the same character, at least as long, and
			// carries no info string.
			if (
				candidate !== null &&
				(candidate[2] ?? "").startsWith(marker[0] ?? "") &&
				(candidate[2] ?? "").length >= marker.length &&
				(candidate[3] ?? "").trim() === ""
			) {
				break;
			}
			close += 1;
		}
		const unterminated = close >= lines.length;
		const contentEnd = unterminated
			? source.length
			: Math.max(contentStart, (offsets[close] ?? source.length) - 1);

		segments.push({
			kind: "code",
			info,
			sql: SQL_INFO.has(info),
			start: Math.min(contentStart, contentEnd),
			end: contentEnd,
			text: source.slice(Math.min(contentStart, contentEnd), contentEnd),
		});

		index = unterminated ? lines.length : close + 1;
		proseStart =
			index >= lines.length ? source.length : (offsets[index] ?? source.length);
	}
	flushProse(source.length);
	return segments;
}

/** Just the runnable blocks, in document order. */
export function sqlBlocks(source: string): MarkdownSegment[] {
	return scanMarkdown(source).filter(
		(segment) => segment.kind === "code" && segment.sql,
	);
}

/**
 * The runnable block containing an offset, or null when the offset is in
 * prose or in a fence of some other language.
 *
 * Used by the completion and formatting providers: markdown prose must
 * not get table-name completion, so "not in a sql fence" returns
 * nothing at all rather than falling through to the SQL provider.
 */
export function sqlBlockAt(
	source: string,
	offset: number,
): MarkdownSegment | null {
	for (const segment of sqlBlocks(source)) {
		if (offset >= segment.start && offset <= segment.end) {
			return segment;
		}
	}
	return null;
}

/**
 * The document with everything that is not a runnable block blanked out,
 * character for character.
 *
 * This is how a markdown runbook gets analysed by the gripes runner
 * without a second code path: the masked string is the same length as
 * the original and keeps its line breaks, so every offset a rule reports
 * is already a document offset. Blanking beats extracting — an extract
 * would need an offset map, and an offset map is a thing that can be
 * wrong.
 */
export function maskNonSql(source: string): string {
	const keep = new Array<boolean>(source.length).fill(false);
	for (const block of sqlBlocks(source)) {
		for (let index = block.start; index < block.end; index += 1) {
			keep[index] = true;
		}
	}
	let out = "";
	for (let index = 0; index < source.length; index += 1) {
		const char = source[index] ?? "";
		// Newlines survive everywhere so line numbers still line up with
		// what the editor shows.
		out += keep[index] || char === "\n" ? char : " ";
	}
	return out;
}
