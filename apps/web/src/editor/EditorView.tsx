import type { IDockviewPanelProps } from "dockview-react";
import { useEffect, useRef } from "react";
import { wsClient } from "../api/ws";
import { db } from "../persistence/db";
import { createDebouncer } from "../persistence/debounce";
import { useDocumentsStore } from "../stores/documents";
import { usePresenceStore } from "../stores/presence";
import { useViewsStore } from "../stores/views";
import { registerEditorHandle, unregisterEditorHandle } from "./handles";
import { monaco } from "./monacoSetup";
import { modelRegistry } from "./registry";
import { remoteViewDecorations } from "./remoteCursors";

const VIEW_STATE_DELAY_MS = 500;
const BROADCAST_DELAY_MS = 250;

/** Live editor instances and their decoration collections by view id. */
const editorInstances = new Map<string, monaco.editor.IStandaloneCodeEditor>();
const editorDecorations = new Map<
	string,
	monaco.editor.IEditorDecorationsCollection
>();

const broadcastDebouncer = createDebouncer();

/** Publish cursor/selection/scroll to the workspace (throttled; the
 * server throttles again at 4 Hz). */
function broadcastViewState(
	editor: monaco.editor.IStandaloneCodeEditor,
	documentId: string,
): void {
	broadcastDebouncer.schedule(
		documentId,
		() => {
			const position = editor.getPosition();
			if (position === null) {
				return;
			}
			const selection = editor.getSelection();
			void wsClient
				.request("view.broadcast", {
					documentId,
					cursor: { line: position.lineNumber, column: position.column },
					selection:
						selection !== null && !selection.isEmpty()
							? {
									startLine: selection.startLineNumber,
									startColumn: selection.startColumn,
									endLine: selection.endLineNumber,
									endColumn: selection.endColumn,
								}
							: null,
					scrollTop: editor.getScrollTop(),
				})
				.catch(() => {});
		},
		BROADCAST_DELAY_MS,
	);
}

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
		const decorations = editor.createDecorationsCollection();
		editorDecorations.set(viewId, decorations);
		editorInstances.set(viewId, editor);
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
				broadcastViewState(editor, documentId);
			}),
			editor.onDidScrollChange(() => {
				viewStateDebouncer.schedule(
					props.api.id,
					persistViewState,
					VIEW_STATE_DELAY_MS,
				);
				broadcastViewState(editor, documentId);
			}),
		];

		return () => {
			disposed = true;
			viewStateDebouncer.cancel(props.api.id);
			persistViewState();
			for (const subscription of subscriptions) {
				subscription.dispose();
			}
			editorDecorations.delete(viewId);
			editorInstances.delete(viewId);
			unregisterEditorHandle(viewId);
			editor.dispose();
			modelRegistry.release(documentId);
		};
	}, [documentId, props.api]);

	// Remote view of the followed member, only when it targets this doc.
	const remoteView = usePresenceStore((state) => {
		if (state.followingUserId === null || documentId === undefined) {
			return undefined;
		}
		const view = state.remoteViews[state.followingUserId];
		return view?.documentId === documentId ? view : undefined;
	});
	const conflict = useDocumentsStore((state) =>
		documentId === undefined ? undefined : state.conflicts[documentId],
	);
	const saveError = useDocumentsStore((state) =>
		documentId === undefined ? undefined : state.saveErrors[documentId],
	);

	useEffect(() => {
		const decorations = editorDecorations.get(props.api.id);
		if (decorations === undefined) {
			return;
		}
		if (remoteView === undefined) {
			decorations.clear();
			return;
		}
		decorations.set(remoteViewDecorations(monaco, remoteView));
	}, [remoteView, props.api]);

	// External content changes (server sync adoption, conflict reload)
	// replace the model's content for clean documents. Dirty documents are
	// never touched — the conflict banner covers them.
	const syncedContent = useDocumentsStore((state) =>
		documentId === undefined ? undefined : state.documents[documentId],
	);
	useEffect(() => {
		if (syncedContent === undefined || syncedContent.dirty) {
			return;
		}
		const model = editorInstances.get(props.api.id)?.getModel();
		if (
			model !== undefined &&
			model !== null &&
			model.getValue() !== syncedContent.currentContent
		) {
			model.setValue(syncedContent.currentContent);
		}
	}, [syncedContent, props.api]);

	if (documentId === undefined || title === undefined) {
		return (
			<div className="editor-missing">
				This document no longer exists. Close the tab.
			</div>
		);
	}
	return (
		<div className="editor-panel">
			{saveError !== undefined && conflict === undefined && (
				<div className="dg-conflict dg-save-error" role="alert">
					Save failed: {saveError}
				</div>
			)}
			{conflict !== undefined && (
				<div className="dg-conflict" role="alert">
					<span>
						Saved elsewhere (revision {conflict.revision}) — your draft is
						unsaved.
					</span>
					<button
						type="button"
						onClick={() =>
							void useDocumentsStore
								.getState()
								.resolveConflict(documentId, "reload")
						}
					>
						Reload server version
					</button>
					<button
						type="button"
						onClick={() =>
							void useDocumentsStore
								.getState()
								.resolveConflict(documentId, "keep")
						}
					>
						Keep mine
					</button>
				</div>
			)}
			<div ref={containerRef} className="editor-container" />
		</div>
	);
}
