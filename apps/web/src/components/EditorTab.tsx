import type { IDockviewPanelHeaderProps } from "dockview-react";
import { useEffect, useRef } from "react";
import { panelDocumentId } from "../app/editorPanels";
import { useDocumentsStore } from "../stores/documents";

/**
 * Editor tab: document title, dirty dot, close button. Dockview attaches
 * drag-and-drop to the surrounding tab element, so tabs stay movable.
 */
export function EditorTab(props: IDockviewPanelHeaderProps) {
	const rootRef = useRef<HTMLDivElement | null>(null);
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

	/**
	 * Middle click closes, like every other tab strip. Bound natively on
	 * dockview's own tab element rather than as a React handler on this
	 * div: dockview owns the interactive control and the drag listeners,
	 * so the whole tab responds — including the padding around this
	 * content — and there is no static element pretending to be a button.
	 *
	 * mousedown, not click, so the browser never starts autoscroll; and
	 * capture, so dockview does not read the press as a drag first.
	 */
	useEffect(() => {
		const tab = rootRef.current?.closest<HTMLElement>(".dv-tab");
		if (tab === null || tab === undefined) {
			return;
		}
		const onMouseDown = (event: MouseEvent) => {
			if (event.button !== 1) {
				return;
			}
			event.preventDefault();
			event.stopPropagation();
			props.api.close();
		};
		tab.addEventListener("mousedown", onMouseDown, { capture: true });
		return () =>
			tab.removeEventListener("mousedown", onMouseDown, { capture: true });
	}, [props.api]);

	// Tab identity (brand-system.md): table view gets ▤ in green, object
	// view ⊞ in cyan, so two tabs named `payments` are not a coin flip.
	const isResults = viewKind === "results" || props.api.id === "results";
	return (
		<div
			ref={rootRef}
			className={isResults ? "dg-tab dg-tab-results" : "dg-tab"}
		>
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
