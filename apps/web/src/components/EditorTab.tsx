import type { IDockviewPanelHeaderProps } from "dockview-react";
import { panelDocumentId } from "../app/editorPanels";
import { useDocumentsStore } from "../stores/documents";

/**
 * Editor tab: document title, dirty dot, close button. Dockview attaches
 * drag-and-drop to the surrounding tab element, so tabs stay movable.
 */
export function EditorTab(props: IDockviewPanelHeaderProps) {
	const documentId = panelDocumentId(props.params);
	const viewKind =
		props.params !== null &&
		typeof props.params === "object" &&
		"view" in props.params &&
		typeof props.params.view === "string"
			? props.params.view
			: undefined;
	const doc = useDocumentsStore((state) =>
		documentId === undefined ? undefined : state.documents[documentId],
	);

	// Tab identity (brand-system.md): table view gets ▤ in green, object
	// view ⊞ in cyan, so two tabs named `payments` are not a coin flip.
	return (
		<div className="dg-tab">
			{viewKind === "table" && (
				<span className="dg-tab-glyph dg-tab-glyph-table">▤</span>
			)}
			{viewKind === "object" && (
				<span className="dg-tab-glyph dg-tab-glyph-object">⊞</span>
			)}
			<span className="dg-tab-title">{doc?.title ?? props.api.title}</span>
			{doc?.dirty === true && (
				<span className="dg-tab-dirty" title="Unsaved changes" />
			)}
			<button
				type="button"
				className="dg-tab-close"
				title="Close"
				onClick={(event) => {
					event.stopPropagation();
					props.api.close();
				}}
			>
				×
			</button>
		</div>
	);
}
