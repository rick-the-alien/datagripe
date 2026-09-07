import type {
	Dismissal,
	DismissalListResult,
	Finding,
} from "@datagripe/contracts";
import { isDismissed } from "@datagripe/contracts";
import type { SchemaInput } from "@datagripe/gripes";
import { RULES, runRules, statementInputFor } from "@datagripe/gripes";
import {
	type SqlDialect,
	splitOptionsForDialect,
	splitStatements,
} from "@datagripe/sql-tools";
import { create } from "zustand";
import { wsClient } from "../api/ws";
import { catalog } from "../editor/completion/catalog";
import { schemaInputFor } from "../editor/completion/schemaInput";
import { createDebouncer } from "../persistence/debounce";
import { useDocumentsStore } from "./documents";
import { useViewsStore } from "./views";

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
	/**
	 * document id → every finding, worst first, dismissed ones included.
	 * Filtering happens on read so a dismissal can be undone without
	 * re-analysing.
	 */
	byDocument: Record<string, Finding[]>;
	/**
	 * `object:<schema>.<name>` → findings from object rules, which the
	 * object view computes because the describe result is its own input.
	 * Kept here so the panel and the status-bar count see them too — a
	 * count reading "no gripes" while two are on screen would undermine
	 * every other number the tool shows.
	 */
	byObject: Record<string, Finding[]>;
	/** Rule ids that threw while evaluating, for the console. Never shown. */
	failed: string[];
	/** Workspace-wide dismissals, loaded on connect. */
	dismissals: Dismissal[];
	/**
	 * Re-analyse one document's text. Debounced per document.
	 *
	 * `connectionId` is what lets schema rules run at all; without it they
	 * are simply not in the set the runner can supply inputs for, so they
	 * stay silent rather than guess.
	 */
	analyse: (
		documentId: string,
		sql: string,
		dialect: SqlDialect,
		connectionId?: string,
	) => void;
	/** Analyse now, skipping the debounce — used on document open. */
	analyseNow: (
		documentId: string,
		sql: string,
		dialect: SqlDialect,
		connectionId?: string,
	) => void;
	/** Drop a document's findings when it closes or is deleted. */
	forget: (documentId: string) => void;
	/** Publish an object view's findings, or clear them when it closes. */
	setObjectFindings: (key: string, findings: Finding[]) => void;
	forgetObject: (key: string) => void;
	/** Load the workspace's dismissals. Called when the socket opens. */
	loadDismissals: () => Promise<void>;
	dismiss: (dismissal: Dismissal) => Promise<void>;
	/** One dismissal, or every one when given nothing. */
	restore: (dismissal?: Dismissal) => Promise<void>;
	reset: () => void;
};

/**
 * Analyse one document. Exported with the schema provider injectable so
 * a test can supply schema facts without a live connection — the schema
 * rules are otherwise only reachable through a loaded catalog, and would
 * go untested at exactly the point where they are wired up.
 */
export function evaluateDocument(
	documentId: string,
	sql: string,
	dialect: SqlDialect,
	connectionId: string | undefined,
	makeSchema: (connectionId: string) => SchemaInput = schemaInputFor,
): { findings: Finding[]; failed: string[] } {
	// A document is many statements; each is analysed on its own so a
	// finding's offsets point into the document, not into the statement.
	const options = splitOptionsForDialect(dialect);
	const schema =
		connectionId === undefined ? undefined : makeSchema(connectionId);
	const findings: Finding[] = [];
	const failed = new Set<string>();
	for (const statement of splitStatements(sql, options)) {
		const result = runRules(RULES, {
			...(schema === undefined ? {} : { schema }),
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

/** What the last analysis of a document was given, so it can be redone. */
type LastAnalysis = {
	sql: string;
	dialect: SqlDialect;
	connectionId: string | undefined;
};

export const useGripesStore = create<GripesState>()((set, get) => {
	const lastAnalysis = new Map<string, LastAnalysis>();

	const apply = (
		documentId: string,
		sql: string,
		dialect: SqlDialect,
		connectionId: string | undefined,
	) => {
		lastAnalysis.set(documentId, { sql, dialect, connectionId });
		const { findings, failed } = evaluateDocument(
			documentId,
			sql,
			dialect,
			connectionId,
		);
		set({
			byDocument: { ...get().byDocument, [documentId]: findings },
			failed,
		});
	};

	// The catalog loads a table's columns on demand, so a schema rule's
	// first look usually knows nothing and correctly stays silent. Redo
	// the analysis when the answer arrives, or the finding never appears.
	catalog.subscribe((connectionId) => {
		for (const [documentId, last] of lastAnalysis) {
			if (last.connectionId === connectionId) {
				apply(documentId, last.sql, last.dialect, last.connectionId);
			}
		}
	});

	return {
		byDocument: {},
		byObject: {},
		failed: [],
		dismissals: [],

		analyse(documentId, sql, dialect, connectionId) {
			debouncer.schedule(
				documentId,
				() => apply(documentId, sql, dialect, connectionId),
				ANALYSE_DELAY_MS,
			);
		},

		analyseNow(documentId, sql, dialect, connectionId) {
			debouncer.cancel(documentId);
			apply(documentId, sql, dialect, connectionId);
		},

		forget(documentId) {
			debouncer.cancel(documentId);
			lastAnalysis.delete(documentId);
			const { [documentId]: _dropped, ...byDocument } = get().byDocument;
			set({ byDocument });
		},

		setObjectFindings(key, findings) {
			const current = get().byObject[key];
			// Object rules re-run on every describe; skip the set when
			// nothing changed, or the panel re-renders on every tab switch.
			if (
				current !== undefined &&
				current.length === findings.length &&
				current.every(
					(finding, index) => finding.ruleId === findings[index]?.ruleId,
				)
			) {
				return;
			}
			set({ byObject: { ...get().byObject, [key]: findings } });
		},

		forgetObject(key) {
			const { [key]: _dropped, ...byObject } = get().byObject;
			set({ byObject });
		},

		async loadDismissals() {
			try {
				const result = await wsClient.request<DismissalListResult>(
					"gripe.dismissals",
					{},
				);
				set({ dismissals: result.dismissals });
			} catch {
				// A gripe engine that cannot read dismissals shows everything,
				// which is noisy but never wrong.
			}
		},

		async dismiss(dismissal) {
			const result = await wsClient.request<DismissalListResult>(
				"gripe.dismiss",
				{ ...dismissal, idempotencyKey: crypto.randomUUID() },
			);
			set({ dismissals: result.dismissals });
		},

		async restore(dismissal) {
			const result = await wsClient.request<DismissalListResult>(
				"gripe.restore",
				dismissal ?? null,
			);
			set({ dismissals: result.dismissals });
		},

		reset() {
			debouncer.flush();
			set({ byDocument: {}, byObject: {}, failed: [], dismissals: [] });
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

/**
 * A closed tab's findings would otherwise linger too, and that is worse
 * than a stale count: clicking such a row cannot go anywhere, because
 * there is no editor left to reveal the offset in. A finding is only
 * ever about what is open.
 *
 * Keyed on views rather than tab-close callbacks for the same reason as
 * above — Dockview drops a panel from several places (the close glyph, a
 * middle click, closing a group, replacing the layout on a workspace
 * switch) and every one of them would have to remember. A document is
 * still open if any view shows it, since splits give one document
 * several views.
 */
useViewsStore.subscribe((state, previous) => {
	// Only documents whose views actually went away, rather than every
	// document absent from `views`. Restoring a layout registers panels
	// one at a time, so a half-populated store would look like a pile of
	// closed tabs and prune findings that had just been analysed.
	const open = new Set(
		Object.values(state.views).map((view) => view.documentId),
	);
	const wasOpen = new Set(
		Object.values(previous.views).map((view) => view.documentId),
	);
	for (const documentId of wasOpen) {
		if (!open.has(documentId)) {
			useGripesStore.getState().forget(documentId);
		}
	}
});

/**
 * Findings that survive the workspace's dismissals — what any surface
 * should actually show. Dismissed findings stay in the store so
 * restoring one costs nothing.
 */
export function visibleFindings(state: GripesState): Finding[] {
	return allFindings(state).filter(
		(finding) => !isDismissed(finding, state.dismissals),
	);
}

/** Every finding from every surface, dismissed included. */
export function allFindings(state: GripesState): Finding[] {
	return [
		...Object.values(state.byDocument).flat(),
		...Object.values(state.byObject).flat(),
	];
}

export function findingCount(state: GripesState): number {
	return visibleFindings(state).length;
}

/**
 * How many findings the dismissals are hiding. "Dismissal is never
 * silent" — without this the feature is a way to make the tool lie
 * quietly.
 */
export function hiddenCount(state: GripesState): number {
	return allFindings(state).length - visibleFindings(state).length;
}

/** The visible findings of one document, for the panel's grouping. */
export function visibleForDocument(
	state: GripesState,
	documentId: string,
): Finding[] {
	return (state.byDocument[documentId] ?? []).filter(
		(finding) => !isDismissed(finding, state.dismissals),
	);
}
