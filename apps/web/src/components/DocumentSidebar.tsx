import { useDocumentsStore } from "../stores/documents";
import { useViewsStore } from "../stores/views";

export type DocumentSidebarProps = {
	onOpen: (documentId: string) => void;
	onDiscard: (documentId: string) => void;
};

/**
 * Every document in the workspace, with open/dirty state. Closing a tab
 * never discards a document — only the explicit discard action here does.
 */
export function DocumentSidebar(props: DocumentSidebarProps) {
	const order = useDocumentsStore((state) => state.order);
	const documents = useDocumentsStore((state) => state.documents);
	const views = useViewsStore((state) => state.views);
	const activeViewId = useViewsStore((state) => state.activeViewId);

	const activeDocumentId =
		activeViewId !== null ? views[activeViewId]?.documentId : undefined;
	const openDocumentIds = new Set(
		Object.values(views).map((view) => view.documentId),
	);

	return (
		<div className="dg-documents">
			<div className="dg-sidebar-heading">Documents</div>
			<ul className="dg-document-list">
				{order.map((id) => {
					const doc = documents[id];
					if (doc === undefined) {
						return null;
					}
					const isActive = id === activeDocumentId;
					return (
						<li key={id}>
							<div
								className={`dg-document-row${
									isActive ? " dg-document-row-active" : ""
								}`}
							>
								<button
									type="button"
									className="dg-document-open"
									title={
										openDocumentIds.has(id) ? "Focus editor" : "Open editor"
									}
									onClick={() => props.onOpen(id)}
									onDoubleClick={() => {
										const title = window.prompt("Rename document", doc.title);
										if (title !== null && title.trim().length > 0) {
											useDocumentsStore
												.getState()
												.renameDocument(id, title.trim());
										}
									}}
								>
									{doc.dirty && <span className="dg-tab-dirty" />}
									{doc.title}
								</button>
								<button
									type="button"
									className="dg-document-delete"
									title={
										doc.dirty
											? "Discard document and its unsaved changes"
											: "Delete document"
									}
									onClick={() => {
										if (
											!doc.dirty ||
											window.confirm(
												`Discard "${doc.title}" and its unsaved changes?`,
											)
										) {
											props.onDiscard(id);
										}
									}}
								>
									×
								</button>
							</div>
						</li>
					);
				})}
			</ul>
			{order.length === 0 && (
				<p className="dg-sidebar-empty">No documents yet.</p>
			)}
		</div>
	);
}
