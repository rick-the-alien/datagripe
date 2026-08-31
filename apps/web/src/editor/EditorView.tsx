import type { IDockviewPanelProps } from "dockview-react";
import { useEffect, useRef } from "react";
import { db } from "../persistence/db";
import { createDebouncer } from "../persistence/debounce";
import { useDocumentsStore } from "../stores/documents";
import { useViewsStore } from "../stores/views";
import { registerEditorHandle, unregisterEditorHandle } from "./handles";
import { monaco } from "./monacoSetup";
import { modelRegistry } from "./registry";

const VIEW_STATE_DELAY_MS = 500;

/**
 * One Dockview panel = one Monaco editor view on a document's shared
 * model. Split-safe: any number of views may attach to the same model
 * while keeping independent cursor/selection/scroll state.
 * See docs/spec/editor-workspace.md.
 */
export function EditorView(props: IDockviewPanelProps) {
	// params arrive from Dockview's serialized layout — narrow, don't cast.
	const params: unknown = props.params;
	const documentId =
		params !== null &&
		typeof params === "object" &&
		"documentId" in params &&
		typeof params.documentId === "string"
			? params.documentId
			: undefined;
	const containerRef = useRef<HTMLDivElement>(null);
	const title = useDocumentsStore((state) =>
		documentId === undefined ? undefined : state.documents[documentId]?.title,
	);

	useEffect(() => {
		if (title !== undefined) {
			props.api.setTitle(title);
		}
	}, [title, props.api]);

	useEffect(() => {
		const container = containerRef.current;
		if (container === null || documentId === undefined) {
			return;
		}
		const doc = useDocumentsStore.getState().documents[documentId];
		if (doc === undefined) {
			return;
		}

		const model = modelRegistry.acquire(doc);
		const editor = monaco.editor.create(container, {
			model,
			theme: "datagripe-dark",
			automaticLayout: true,
			minimap: { enabled: false },
			fontSize: 13,
			scrollBeyondLastLine: false,
			padding: { top: 8 },
		});

		const viewId = props.api.id;
		registerEditorHandle(viewId, {
			getText: () => model.getValue(),
			getSelection: () => {
				const selection = editor.getSelection();
				if (selection === null || selection.isEmpty()) {
					return { text: "", isEmpty: true };
				}
				return { text: model.getValueInRange(selection), isEmpty: false };
			},
			getCursorOffset: () => {
				const position = editor.getPosition();
				return position === null ? 0 : model.getOffsetAt(position);
			},
		});

		let disposed = false;
		const viewStateDebouncer = createDebouncer();
		const persistViewState = () => {
			const state = editor.saveViewState();
			if (state !== null) {
				void db.viewStates.put({
					id: props.api.id,
					documentId,
					state,
					updatedAt: new Date().toISOString(),
				});
			}
		};

		// Restore this view's cursor/selection/scroll from the last session.
		void db.viewStates.get(props.api.id).then((row) => {
			if (disposed || row === undefined) {
				return;
			}
			// Cast to named const: state was written by editor.saveViewState()
			// on this same panel; IndexedDB round-trip erases the type.
			const state = row.state as monaco.editor.ICodeEditorViewState;
			editor.restoreViewState(state);
		});

		const subscriptions = [
			editor.onDidChangeModelContent(() => {
				useDocumentsStore
					.getState()
					.updateContent(documentId, model.getValue());
			}),
			// Ground truth for Ctrl/Cmd+S routing: which editor has text
			// focus. Per-editor Monaco keybindings are NOT used — addCommand
			// registrations are global and collide across editor instances
			// (the later editor shadows the earlier one's binding).
			editor.onDidFocusEditorText(() => {
				useViewsStore.getState().setActiveView(props.api.id);
			}),
			editor.onDidChangeCursorSelection(() => {
				viewStateDebouncer.schedule(
					props.api.id,
					persistViewState,
					VIEW_STATE_DELAY_MS,
				);
			}),
			editor.onDidScrollChange(() => {
				viewStateDebouncer.schedule(
					props.api.id,
					persistViewState,
					VIEW_STATE_DELAY_MS,
				);
			}),
		];

		return () => {
			disposed = true;
			viewStateDebouncer.cancel(props.api.id);
			persistViewState();
			for (const subscription of subscriptions) {
				subscription.dispose();
			}
			unregisterEditorHandle(viewId);
			editor.dispose();
			modelRegistry.release(documentId);
		};
	}, [documentId, props.api]);

	if (documentId === undefined || title === undefined) {
		return (
			<div className="editor-missing">
				This document no longer exists. Close the tab.
			</div>
		);
	}
	return <div ref={containerRef} className="editor-container" />;
}
