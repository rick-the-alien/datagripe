import { useEffect, useState } from "react";
import type { EditorDocument } from "../stores/documents";
import { useDocumentsStore } from "../stores/documents";
import { useViewsStore } from "../stores/views";

export type DocumentSidebarProps = {
	/** Which list this section renders; the section frame owns the heading. */
	kind: "shared" | "scratch";
	onCreate: (shared: boolean) => void;
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

	const [menu, setMenu] = useState<{
		x: number;
		y: number;
		doc: EditorDocument;
	} | null>(null);

	const rename = (doc: EditorDocument) => {
		const title = window.prompt("Rename document", doc.title);
		if (title !== null && title.trim().length > 0) {
			useDocumentsStore.getState().renameDocument(doc.id, title.trim());
		}
	};

	const remove = (doc: EditorDocument) => {
		if (
			!doc.dirty ||
			window.confirm(`Discard "${doc.title}" and its unsaved changes?`)
		) {
			props.onDiscard(doc.id);
		}
	};

	// Context menu dismisses on outside click / Escape.
	useEffect(() => {
		if (menu === null) {
			return;
		}
		const close = () => setMenu(null);
		const onKeyDown = (event: KeyboardEvent) => {
			if (event.key === "Escape") {
				setMenu(null);
			}
		};
		window.addEventListener("mousedown", close);
		window.addEventListener("keydown", onKeyDown);
		return () => {
			window.removeEventListener("mousedown", close);
			window.removeEventListener("keydown", onKeyDown);
		};
	}, [menu]);

	const scratch = order.filter((id) => documents[id]?.shared !== true);
	const shared = order.filter((id) => documents[id]?.shared === true);

	const renderRow = (doc: EditorDocument) => {
		const isActive = doc.id === activeDocumentId;
		return (
			<li key={doc.id}>
				{/* biome-ignore lint/a11y/noStaticElementInteractions: row-level context menu; the interactive content is the buttons inside */}
				<div
					className={`dg-document-row${
						isActive ? " dg-document-row-active" : ""
					}`}
					onContextMenu={(event) => {
						event.preventDefault();
						setMenu({ x: event.clientX, y: event.clientY, doc });
					}}
				>
					<button
						type="button"
						className="dg-document-open"
						title={openDocumentIds.has(doc.id) ? "Focus editor" : "Open editor"}
						onClick={() => props.onOpen(doc.id)}
						onDoubleClick={() => rename(doc)}
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
						onClick={() => remove(doc)}
					>
						×
					</button>
				</div>
			</li>
		);
	};

	const ids = props.kind === "shared" ? shared : scratch;
	const create = () => props.onCreate(props.kind === "shared");
	const label = props.kind === "shared" ? "new shared file" : "new scratchpad";

	return (
		<div className="dg-documents">
			{ids.length === 0 ? (
				<>
					<p className="dg-sidebar-empty">
						{props.kind === "shared"
							? "No shared files. Shared files sync to every workspace member."
							: "No scratchpads. These stay local to your browser — experiments and adhoc queries are never shared."}
					</p>
					<button type="button" className="dg-doc-new-empty" onClick={create}>
						{label}
					</button>
				</>
			) : (
				<ul className="dg-document-list">
					{ids.map((id) => {
						const doc = documents[id];
						return doc === undefined ? null : renderRow(doc);
					})}
				</ul>
			)}
			{ids.length > 0 && (
				<button type="button" className="dg-doc-new" onClick={create}>
					+ {label}
				</button>
			)}
			{menu !== null && (
				<div
					className="dg-context-menu"
					role="menu"
					style={{ top: menu.y, left: menu.x }}
					onMouseDown={(event) => event.stopPropagation()}
				>
					<button
						type="button"
						className="dg-context-item"
						role="menuitem"
						onClick={() => {
							const doc = menu.doc;
							setMenu(null);
							rename(doc);
						}}
					>
						rename… <kbd>dbl click</kbd>
					</button>
					<button
						type="button"
						className="dg-context-item"
						role="menuitem"
						onClick={() => {
							const doc = menu.doc;
							setMenu(null);
							remove(doc);
						}}
					>
						delete
					</button>
				</div>
			)}
		</div>
	);
}
