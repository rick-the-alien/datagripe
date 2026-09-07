import type { DockviewApi } from "dockview-react";
import { revealInDocument } from "../editor/handles";
import { EDITOR_PANEL_COMPONENT } from "../persistence/layout";
import { type EditorDocument, useDocumentsStore } from "../stores/documents";
import { useViewsStore } from "../stores/views";

/** Read the document binding of a Dockview panel; undefined if not an editor panel. */
export function panelDocumentId(params: unknown): string | undefined {
	return params !== null &&
		typeof params === "object" &&
		"documentId" in params &&
		typeof params.documentId === "string"
		? params.documentId
		: undefined;
}

/**
 * Open a document in the workspace: focus its existing view when one is
 * open, otherwise add a new editor panel as a tab of the active group.
 */
export function openEditorPanel(api: DockviewApi, doc: EditorDocument): void {
	const existing = api.panels.find(
		(panel) => panelDocumentId(panel.params) === doc.id,
	);
	if (existing !== undefined) {
		existing.focus();
		return;
	}
	api.addPanel({
		id: `view-${crypto.randomUUID()}`,
		component: EDITOR_PANEL_COMPONENT,
		title: doc.title,
		params: { documentId: doc.id },
		// Keep hidden editors mounted: tab switches are pure visibility
		// changes, no editor churn (docs/spec/editor-workspace.md).
		renderer: "always",
	});
}

/** Close every view of a document (used before discarding the document). */
export function closeEditorPanels(api: DockviewApi, documentId: string): void {
	for (const panel of api.panels) {
		if (panelDocumentId(panel.params) === documentId) {
			api.removePanel(panel);
		}
	}
}

/**
 * The Dockview api, for the surfaces that navigate rather than open —
 * registered once by the workspace, same seam as `viewPanels.ts`.
 */
let panelApi: DockviewApi | null = null;

export function registerEditorPanelApi(api: DockviewApi): void {
	panelApi = api;
}

/** How long to wait for a freshly opened editor to register its handle. */
const REVEAL_ATTEMPTS = 40;

function viewsShowing(documentId: string): string[] {
	return Object.entries(useViewsStore.getState().views)
		.filter(([, view]) => view.documentId === documentId)
		.map(([viewId]) => viewId);
}

/**
 * Bring a document's tab to the front and put the caret on an offset —
 * what clicking a gripe row does.
 *
 * Activating the panel is not optional. Editors are kept mounted so tab
 * switches cost nothing (docs/spec/editor-workspace.md), which means a
 * hidden editor will happily scroll and take focus with nothing visible
 * changing — the row looks broken while doing exactly what it was told.
 *
 * Opens the document when no view shows it. A finding is only ever about
 * an open document, so this should not arise; it costs two lines and
 * beats a click that silently does nothing if it ever does.
 */
export function revealInEditor(documentId: string, offset: number): boolean {
	const api = panelApi;
	if (api === null) {
		return revealInDocument(viewsShowing(documentId), offset);
	}

	const panel = api.panels.find(
		(candidate) => panelDocumentId(candidate.params) === documentId,
	);
	if (panel === undefined) {
		const doc = useDocumentsStore.getState().documents[documentId];
		if (doc === undefined) {
			return false;
		}
		openEditorPanel(api, doc);
		// The editor registers its handle when Monaco mounts, which is
		// after this turn of the event loop.
		let attempts = 0;
		const settle = () => {
			if (revealInDocument(viewsShowing(documentId), offset)) {
				return;
			}
			attempts += 1;
			if (attempts < REVEAL_ATTEMPTS) {
				requestAnimationFrame(settle);
			}
		};
		requestAnimationFrame(settle);
		return true;
	}

	panel.api.setActive();
	return revealInDocument(viewsShowing(documentId), offset);
}
