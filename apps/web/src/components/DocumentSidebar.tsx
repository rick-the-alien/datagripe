import type { EditorDocument } from "../stores/documents";
import { useDocumentsStore } from "../stores/documents";
import { useViewsStore } from "../stores/views";

export type DocumentSidebarProps = {
	onOpen: (documentId: string) => void;
	onDiscard: (documentId: string) => void;
};

/**
 * Documents in two clearly separated sections: local scratchpads
 * (IndexedDB, never shared) and workspace files (server-side, shared
 * with every member). Closing a tab never discards a document — only
 * the explicit discard action here does.
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

	const scratch = order.filter((id) => documents[id]?.shared !== true);
	const shared = order.filter((id) => documents[id]?.shared === true);

	const renderRow = (doc: EditorDocument) => {
		const isActive = doc.id === activeDocumentId;
		return (
			<li key={doc.id}>
				<div
					className={`dg-document-row${
						isActive ? " dg-document-row-active" : ""
					}`}
				>
					<button
						type="button"
						className="dg-document-open"
						title={openDocumentIds.has(doc.id) ? "Focus editor" : "Open editor"}
						onClick={() => props.onOpen(doc.id)}
						onDoubleClick={() => {
							const title = window.prompt("Rename document", doc.title);
							if (title !== null && title.trim().length > 0) {
								useDocumentsStore
									.getState()
									.renameDocument(doc.id, title.trim());
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
								props.onDiscard(doc.id);
							}
						}}
					>
						×
					</button>
				</div>
			</li>
		);
	};

	return (
		<div className="dg-documents">
			<div className="dg-sidebar-heading">Workspace files</div>
			<ul className="dg-document-list">
				{shared.map((id) => {
					const doc = documents[id];
					return doc === undefined ? null : renderRow(doc);
				})}
			</ul>
			{shared.length === 0 && (
				<p className="dg-sidebar-empty">
					No shared files. "New shared file" creates one every member sees.
				</p>
			)}

			<div className="dg-sidebar-heading">Scratchpads (local)</div>
			<ul className="dg-document-list">
				{scratch.map((id) => {
					const doc = documents[id];
					return doc === undefined ? null : renderRow(doc);
				})}
			</ul>
			{scratch.length === 0 && (
				<p className="dg-sidebar-empty">
					No scratchpads. These stay local to your browser — experiments and
					adhoc queries are never shared.
				</p>
			)}
		</div>
	);
}
