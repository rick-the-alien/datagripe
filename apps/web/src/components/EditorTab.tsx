import type { IDockviewPanelHeaderProps } from "dockview-react";
import { panelDocumentId } from "../app/editorPanels";
import { useDocumentsStore } from "../stores/documents";

/**
 * Editor tab: document title, dirty dot, close button. Dockview attaches
 * drag-and-drop to the surrounding tab element, so tabs stay movable.
 */
export function EditorTab(props: IDockviewPanelHeaderProps) {
	const documentId = panelDocumentId(props.params);
	const doc = useDocumentsStore((state) =>
		documentId === undefined ? undefined : state.documents[documentId],
	);

	return (
		<div className="dg-tab">
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
