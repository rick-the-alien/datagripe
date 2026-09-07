import { beforeEach, describe, expect, test } from "bun:test";
import type { SchemaInput } from "@datagripe/gripes";
import { useDocumentsStore } from "./documents";
import {
	allFindings,
	evaluateDocument,
	findingCount,
	useGripesStore,
} from "./gripes";

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

describe("a deleted document's findings do not linger", () => {
	test("dropping a document from the documents store prunes its findings", () => {
		// Otherwise the status-bar count includes findings for a document
		// that is gone, and the panel renders a row with no title — the
		// title comes from the documents store.
		useDocumentsStore.setState({
			documents: {
				"doc-1": {
					id: "doc-1",
					title: "one.sql",
					language: "sql",
					savedContent: "",
					currentContent: "select * from a join b",
					revision: 0,
					dirty: true,
					shared: false,
					createdAt: "",
					updatedAt: "",
				},
			},
		});
		useGripesStore
			.getState()
			.analyseNow("doc-1", "select * from a join b", "postgres");
		expect(findingCount(useGripesStore.getState())).toBe(1);

		useDocumentsStore.setState({ documents: {} });
		expect(findingCount(useGripesStore.getState())).toBe(0);
		expect(useGripesStore.getState().byDocument["doc-1"]).toBeUndefined();
	});

	test("a document that still exists keeps its findings", () => {
		// Closing a tab is not deleting a document, and its gripes are
		// still true.
		const doc = {
			id: "doc-1",
			title: "one.sql",
			language: "sql" as const,
			savedContent: "",
			currentContent: "select * from a join b",
			revision: 0,
			dirty: true,
			shared: false,
			createdAt: "",
			updatedAt: "",
		};
		useDocumentsStore.setState({ documents: { "doc-1": doc } });
		useGripesStore
			.getState()
			.analyseNow("doc-1", "select * from a join b", "postgres");
		useDocumentsStore.setState({
			documents: { "doc-1": { ...doc, title: "renamed.sql" } },
		});
		expect(findingCount(useGripesStore.getState())).toBe(1);
	});
});

describe("schema rules", () => {
	/** A schema that knows one thing, as a loaded catalog would. */
	const schema: SchemaInput = {
		rowsFor: () => null,
		indexLeadsWith: () => null,
		isNullable: (_schema, table, column) =>
			table === "film" && column === "release_year" ? true : null,
	};

	test("fire once the schema can answer", () => {
		const { findings } = evaluateDocument(
			"doc-1",
			"select title from film where release_year <> 2006",
			"postgres",
			"conn-1",
			() => schema,
		);
		expect(findings.map((finding) => finding.ruleId)).toEqual([
			"column.nullable-inequality",
		]);
		expect(findings[0]?.facts).toEqual({ column: "release_year" });
	});

	test("stay silent while the schema knows nothing", () => {
		// The catalog loads columns on demand, so this is the normal state
		// on first sight and it must not produce a finding.
		const { findings } = evaluateDocument(
			"doc-1",
			"select title from film where release_year <> 2006",
			"postgres",
			"conn-1",
			() => ({
				rowsFor: () => null,
				indexLeadsWith: () => null,
				isNullable: () => null,
			}),
		);
		expect(findings).toEqual([]);
	});

	test("do not run at all without a connection", () => {
		const { findings } = evaluateDocument(
			"doc-1",
			"select title from film where release_year <> 2006",
			"postgres",
			undefined,
		);
		expect(findings).toEqual([]);
	});
});

describe("dialect gating", () => {
	test("a Postgres-only rule does not fire on MySQL", () => {
		const sql = "create index idx_film_title on film (title)";
		expect(
			evaluateDocument("doc-1", sql, "postgres", undefined).findings,
		).toHaveLength(1);
		expect(evaluateDocument("doc-1", sql, "mysql", undefined).findings).toEqual(
			[],
		);
	});
});
