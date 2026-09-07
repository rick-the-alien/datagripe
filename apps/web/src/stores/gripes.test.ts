import { beforeEach, describe, expect, test } from "bun:test";
import { allFindings, findingCount, useGripesStore } from "./gripes";

/**
 * The client-side runner (docs/spec/gripes.md). `analyseNow` skips the
 * debounce so the behaviour under test is the analysis, not the timer.
 */

beforeEach(() => {
	useGripesStore.getState().reset();
});

describe("analyseNow", () => {
	test("finds a gripe in a document", () => {
		useGripesStore
			.getState()
			.analyseNow("doc-1", "select * from a join b", "postgres");
		const findings = useGripesStore.getState().byDocument["doc-1"] ?? [];
		expect(findings).toHaveLength(1);
		expect(findings[0]?.ruleId).toBe("join.no-condition");
	});

	test("a clean document produces nothing", () => {
		useGripesStore
			.getState()
			.analyseNow(
				"doc-1",
				"select * from a join b on a.id = b.a_id",
				"postgres",
			);
		expect(useGripesStore.getState().byDocument["doc-1"]).toEqual([]);
	});

	test("offsets are document-relative across several statements", () => {
		// Each statement is analysed on its own, so a finding in the second
		// one must still point at where it is in the whole document.
		const sql = "select 1;\nselect * from a join b";
		useGripesStore.getState().analyseNow("doc-1", sql, "postgres");
		const finding = useGripesStore.getState().byDocument["doc-1"]?.[0];
		expect(finding?.at.kind).toBe("document");
		if (finding?.at.kind === "document") {
			expect(sql.slice(finding.at.start, finding.at.end)).toBe("join");
		}
	});

	test("several statements each contribute their findings", () => {
		useGripesStore
			.getState()
			.analyseNow(
				"doc-1",
				"select * from a join b; select * from c join d",
				"postgres",
			);
		expect(useGripesStore.getState().byDocument["doc-1"]).toHaveLength(2);
	});

	test("re-analysing replaces rather than accumulates", () => {
		const store = useGripesStore.getState();
		store.analyseNow("doc-1", "select * from a join b", "postgres");
		store.analyseNow("doc-1", "select 1", "postgres");
		expect(useGripesStore.getState().byDocument["doc-1"]).toEqual([]);
	});

	test("a dialect's own quoting is respected", () => {
		// `join` in backticks is a column name in mysql and a keyword-shaped
		// identifier nowhere else.
		useGripesStore
			.getState()
			.analyseNow("doc-1", "select `join` from t", "mysql");
		expect(useGripesStore.getState().byDocument["doc-1"]).toEqual([]);
	});

	test("documents are independent", () => {
		const store = useGripesStore.getState();
		store.analyseNow("doc-1", "select * from a join b", "postgres");
		store.analyseNow("doc-2", "select 1", "postgres");
		expect(useGripesStore.getState().byDocument["doc-1"]).toHaveLength(1);
		expect(useGripesStore.getState().byDocument["doc-2"]).toEqual([]);
	});
});

describe("forget", () => {
	test("drops one document's findings and leaves the rest", () => {
		const store = useGripesStore.getState();
		store.analyseNow("doc-1", "select * from a join b", "postgres");
		store.analyseNow("doc-2", "select * from c join d", "postgres");
		useGripesStore.getState().forget("doc-1");
		expect(useGripesStore.getState().byDocument["doc-1"]).toBeUndefined();
		expect(useGripesStore.getState().byDocument["doc-2"]).toHaveLength(1);
	});
});

describe("counts", () => {
	test("across every open document", () => {
		const store = useGripesStore.getState();
		store.analyseNow("doc-1", "select * from a join b", "postgres");
		store.analyseNow("doc-2", "select * from c join d join e", "postgres");
		expect(findingCount(useGripesStore.getState())).toBe(3);
		expect(allFindings(useGripesStore.getState())).toHaveLength(3);
	});

	test("zero on an empty store", () => {
		expect(findingCount(useGripesStore.getState())).toBe(0);
	});
});
