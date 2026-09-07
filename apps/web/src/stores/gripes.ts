import type { Finding } from "@datagripe/contracts";
import { RULES, runRules, statementInputFor } from "@datagripe/gripes";
import { splitOptionsForDialect, splitStatements } from "@datagripe/sql-tools";
import { create } from "zustand";
import { createDebouncer } from "../persistence/debounce";
import { useDocumentsStore } from "./documents";

/**
 * Client-side gripe findings (docs/spec/gripes.md "Where rules run").
 *
 * Statement rules run here because their inputs are already in memory —
 * findings appear as you type with no round trip. Execution rules run on
 * the server, where the connection is, and will arrive through the
 * execution event stream; this store is where both end up.
 *
 * Only findings, never sentences. The wording is chosen at render time
 * from the reader's attitude level, so changing that level re-renders
 * and never re-analyses.
 */

/** Long enough that typing mid-word does not flicker findings. */
const ANALYSE_DELAY_MS = 400;

const debouncer = createDebouncer();

export type GripesState = {
	/** document id → findings, worst first. */
	byDocument: Record<string, Finding[]>;
	/** Rule ids that threw while evaluating, for the console. Never shown. */
	failed: string[];
	/** Re-analyse one document's text. Debounced per document. */
	analyse: (documentId: string, sql: string, dialect: string) => void;
	/** Analyse now, skipping the debounce — used on document open. */
	analyseNow: (documentId: string, sql: string, dialect: string) => void;
	/** Drop a document's findings when it closes or is deleted. */
	forget: (documentId: string) => void;
	reset: () => void;
};

function evaluate(
	documentId: string,
	sql: string,
	dialect: string,
): { findings: Finding[]; failed: string[] } {
	// A document is many statements; each is analysed on its own so a
	// finding's offsets point into the document, not into the statement.
	const options = splitOptionsForDialect(dialect);
	const findings: Finding[] = [];
	const failed = new Set<string>();
	for (const statement of splitStatements(sql, options)) {
		const result = runRules(RULES, {
			statement: statementInputFor({
				documentId,
				dialect,
				text: statement.text,
				offset: statement.start,
			}),
		});
		findings.push(...result.findings);
		for (const id of result.failed) {
			failed.add(id);
		}
	}
	return { findings, failed: [...failed] };
}

export const useGripesStore = create<GripesState>()((set, get) => {
	const apply = (documentId: string, sql: string, dialect: string) => {
		const { findings, failed } = evaluate(documentId, sql, dialect);
		set({
			byDocument: { ...get().byDocument, [documentId]: findings },
			failed,
		});
	};

	return {
		byDocument: {},
		failed: [],

		analyse(documentId, sql, dialect) {
			debouncer.schedule(
				documentId,
				() => apply(documentId, sql, dialect),
				ANALYSE_DELAY_MS,
			);
		},

		analyseNow(documentId, sql, dialect) {
			debouncer.cancel(documentId);
			apply(documentId, sql, dialect);
		},

		forget(documentId) {
			debouncer.cancel(documentId);
			const { [documentId]: _dropped, ...byDocument } = get().byDocument;
			set({ byDocument });
		},

		reset() {
			debouncer.flush();
			set({ byDocument: {}, failed: [] });
		},
	};
});

/**
 * A deleted document's findings would otherwise linger: the count would
 * include them and the panel would render a row with no title, since the
 * title comes from the documents store.
 *
 * Pruning here rather than at each deletion site is deliberate. There
 * are two paths that drop a document today — discarding one locally and
 * a `document.changed` archive broadcast from another member — and the
 * next one added would have to remember to call `forget`. This way it
 * cannot be forgotten, and the dependency points the right way: gripes
 * know about documents, documents know nothing about gripes.
 */
useDocumentsStore.subscribe((state) => {
	const known = state.documents;
	const stale = Object.keys(useGripesStore.getState().byDocument).filter(
		(documentId) => known[documentId] === undefined,
	);
	for (const documentId of stale) {
		useGripesStore.getState().forget(documentId);
	}
});

/** Every finding across every open document, already sorted per document. */
export function allFindings(state: GripesState): Finding[] {
	return Object.values(state.byDocument).flat();
}

export function findingCount(state: GripesState): number {
	return allFindings(state).length;
}
