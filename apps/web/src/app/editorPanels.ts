import type { DockviewApi } from "dockview-react";
import { EDITOR_PANEL_COMPONENT } from "../persistence/layout";
import type { EditorDocument } from "../stores/documents";

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
