import { describe, expect, test } from "bun:test";
import { maskNonSql, scanMarkdown, sqlBlockAt, sqlBlocks } from "./blocks";

/**
 * Fence scanning (docs/spec/markdown-documents.md "SQL blocks").
 *
 * The property under test throughout is that **offsets are document
 * offsets**. Three consumers depend on this scanner agreeing with
 * itself — the renderer, the gripes runner and the editor's providers —
 * and an offset that is off by one is a squiggle under the wrong word.
 */

const RUNBOOK = `# Nightly reconciliation

When the job reports a gap, find the orphans:

\`\`\`sql
select * from ledger.entries e
where not exists (select 1 from ledger.postings p where p.entry = e.id);
\`\`\`

Then re-run it.

\`\`\`bash
./reconcile --from 2026-09-01
\`\`\`
`;

describe("scanMarkdown", () => {
	test("offsets point into the document, not into the block", () => {
		const blocks = sqlBlocks(RUNBOOK);
		expect(blocks).toHaveLength(1);
		const block = blocks[0];
		if (block === undefined) {
			throw new Error("expected one sql block");
		}
		// The slice at the reported offsets is the block's own text: this
		// is the whole contract the gripes runner relies on.
		expect(RUNBOOK.slice(block.start, block.end)).toBe(block.text);
		expect(block.text).toStartWith("select * from ledger.entries");
		expect(block.text).toEndWith("p.entry = e.id);");
	});

	test("a non-sql fence is a block but not a runnable one", () => {
		const code = scanMarkdown(RUNBOOK).filter(
			(segment) => segment.kind === "code",
		);
		expect(code.map((segment) => segment.info)).toEqual(["sql", "bash"]);
		expect(code.map((segment) => segment.sql)).toEqual([true, false]);
	});

	test("prose and code partition the document with no gaps", () => {
		const segments = scanMarkdown(RUNBOOK);
		// Every character belongs to exactly one segment or to a fence
		// delimiter line; nothing is claimed twice.
		let previousEnd = 0;
		for (const segment of segments) {
			expect(segment.start).toBeGreaterThanOrEqual(previousEnd);
			previousEnd = segment.end;
		}
	});

	test("the info string is matched case-insensitively, with aliases", () => {
		for (const info of ["sql", "SQL", " sql ", "postgresql", "mysql"]) {
			expect(sqlBlocks(`\`\`\`${info}\nselect 1;\n\`\`\`\n`)).toHaveLength(1);
		}
		for (const info of ["bash", "json", "sqlite3", ""]) {
			expect(sqlBlocks(`\`\`\`${info}\nselect 1;\n\`\`\`\n`)).toHaveLength(0);
		}
	});

	test("an unterminated fence runs to the end and eats nothing else", () => {
		// Somebody mid-typing. The pane must not blank out, and the rest of
		// the document must not be swallowed by an error path.
		const source = "intro\n\n```sql\nselect 1;\n";
		const blocks = sqlBlocks(source);
		expect(blocks).toHaveLength(1);
		expect(blocks[0]?.text).toBe("select 1;\n");
		expect(scanMarkdown(source)[0]?.text).toBe("intro\n\n");
	});

	test("a tilde fence works, and a shorter one does not close a longer", () => {
		expect(sqlBlocks("~~~sql\nselect 1;\n~~~\n")).toHaveLength(1);
		const nested = "````sql\n```\nselect 1;\n```\n````\n";
		const blocks = sqlBlocks(nested);
		expect(blocks).toHaveLength(1);
		expect(blocks[0]?.text).toContain("select 1;");
	});
});

describe("sqlBlockAt", () => {
	test("prose is not a sql fence", () => {
		// The reason this matters: completion falling through here would
		// offer table names in the middle of a paragraph.
		expect(sqlBlockAt(RUNBOOK, 5)).toBeNull();
		expect(sqlBlockAt(RUNBOOK, RUNBOOK.indexOf("Then re-run"))).toBeNull();
	});

	test("a bash fence is not a sql fence", () => {
		expect(sqlBlockAt(RUNBOOK, RUNBOOK.indexOf("./reconcile"))).toBeNull();
	});

	test("an offset inside the sql fence finds it", () => {
		const offset = RUNBOOK.indexOf("ledger.entries");
		expect(sqlBlockAt(RUNBOOK, offset)?.text).toContain("ledger.entries");
	});
});

describe("maskNonSql", () => {
	test("keeps the length and the line breaks", () => {
		const masked = maskNonSql(RUNBOOK);
		expect(masked).toHaveLength(RUNBOOK.length);
		expect(masked.split("\n")).toHaveLength(RUNBOOK.split("\n").length);
	});

	test("keeps sql and blanks everything else", () => {
		const masked = maskNonSql(RUNBOOK);
		expect(masked).toContain("select * from ledger.entries");
		expect(masked).not.toContain("Nightly reconciliation");
		expect(masked).not.toContain("./reconcile");
	});

	test("a masked offset is the same offset", () => {
		// This is the point of masking rather than extracting: there is no
		// offset map to get wrong.
		const offset = RUNBOOK.indexOf("select * from");
		expect(maskNonSql(RUNBOOK).slice(offset, offset + 13)).toBe(
			"select * from",
		);
	});
});
