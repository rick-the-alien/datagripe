import type { GripeSeverity } from "@datagripe/contracts";
import { isDismissed } from "@datagripe/contracts";
import { MESSAGES, renderFinding, renderFooter } from "@datagripe/gripes";
import type { IDockviewPanelProps } from "dockview-react";
import { useEffect, useMemo, useRef } from "react";
import { wsClient } from "../api/ws";
import { openEditorPanel } from "../app/editorPanels";
import { MarkdownView } from "../components/MarkdownView";
import { db } from "../persistence/db";
import { createDebouncer } from "../persistence/debounce";
import { useBrandingStore } from "../stores/branding";
import {
	connectionIdForDocument,
	dialectForConnection,
} from "../stores/documentConnection";
import { useDocumentsStore } from "../stores/documents";
import { useGripesStore } from "../stores/gripes";
import { usePresenceStore } from "../stores/presence";
import { useExecutionsStore } from "../stores/runtime";
import { useSessionStore } from "../stores/session";
import { useViewsStore } from "../stores/views";
import { registerEditorHandle, unregisterEditorHandle } from "./handles";
import { maskNonSql } from "./markdown/blocks";
import { resolveRelativeFile } from "./markdown/links";
import { monaco } from "./monacoSetup";
import { modelRegistry } from "./registry";
import { remoteViewDecorations } from "./remoteCursors";

const VIEW_STATE_DELAY_MS = 500;

/**
 * How many findings get a mark on the annotation rail. Past roughly
 * forty the rail stops being a map (mocks/scrollbars.html), so the rest
 * keep their gutter glyph and squiggle and give up the rail mark.
 */
const RAIL_CAP = 40;

/** Severity accents, resolved here because Monaco needs real colours. */
const RAIL_COLOURS: Record<GripeSeverity, string> = {
	blocker: "#FF3EA5",
	warning: "#8B5CF6",
	style: "#00E599",
};
const BROADCAST_DELAY_MS = 250;

/** Live editor instances and their decoration collections by view id. */
const editorInstances = new Map<string, monaco.editor.IStandaloneCodeEditor>();
const editorDecorations = new Map<
	string,
	monaco.editor.IEditorDecorationsCollection
>();
/** Statement result glyphs (executed-statement gutter ticks), per view. */
const statementDecorations = new Map<
	string,
	monaco.editor.IEditorDecorationsCollection
>();
/** Gripe glyphs and squiggles (docs/spec/gripes.md), per view. */
const gripeDecorations = new Map<
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
	const language = useDocumentsStore((state) =>
		documentId === undefined
			? undefined
			: state.documents[documentId]?.language,
	);
	const content = useDocumentsStore((state) =>
		documentId === undefined
			? undefined
			: state.documents[documentId]?.currentContent,
	);

	/**
	 * View or edit, for a markdown document
	 * (docs/spec/markdown-documents.md "Two modes").
	 *
	 * Per *view*, not per document: splitting a runbook to read it beside
	 * its own source is a thing people do, and it is free if mode is a
	 * view property. It rides on the Dockview panel parameters so it
	 * persists with the layout without a store of its own.
	 */
	const savedMode =
		params !== null &&
		typeof params === "object" &&
		"mode" in params &&
		(params.mode === "view" || params.mode === "edit")
			? params.mode
			: undefined;
	// Markdown opens rendered, because a runbook is something you read.
	const mode = savedMode ?? (language === "markdown" ? "view" : "edit");
	const rendered = language === "markdown" && mode === "view";
	const setMode = (next: "view" | "edit") => {
		props.api.updateParameters({
			...(params !== null && typeof params === "object" ? params : {}),
			mode: next,
		});
	};

	useEffect(() => {
		if (title !== undefined) {
			props.api.setTitle(title);
		}
	}, [title, props.api]);

	useEffect(() => {
		const container = containerRef.current;
		// In view mode there is no editor at all: the pane is rendered
		// markdown, and the container it would mount into is not there.
		if (container === null || documentId === undefined || rendered) {
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
			glyphMargin: true,
			fontSize: 13,
			scrollBeyondLastLine: false,
			padding: { top: 8 },
			// Middle-click drag makes the columnar, multi-line selection
			// IntelliJ does. Monaco implements it already, but hands the
			// middle button to the Linux primary clipboard instead unless
			// `selectionClipboard` is off — and a browser tab has no primary
			// clipboard to paste from, so nothing is given up.
			selectionClipboard: false,
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
			getSelectionOffsets: () => {
				const selection = editor.getSelection();
				if (selection === null || selection.isEmpty()) {
					return null;
				}
				return {
					start: model.getOffsetAt(selection.getStartPosition()),
					end: model.getOffsetAt(selection.getEndPosition()),
				};
			},
			reveal: (offset) => {
				const position = model.getPositionAt(offset);
				// revealPositionInCenterIfOutsideViewport, not
				// revealPositionInCenter: jumping a line that is already on
				// screen throws away the reader's sense of place.
				editor.revealPositionInCenterIfOutsideViewport(position);
				editor.setPosition(position);
				editor.focus();
			},
		});

		let disposed = false;
		const viewStateDebouncer = createDebouncer();
		const decorations = editor.createDecorationsCollection();
		editorDecorations.set(viewId, decorations);
		statementDecorations.set(viewId, editor.createDecorationsCollection());
		gripeDecorations.set(viewId, editor.createDecorationsCollection());
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
			statementDecorations.delete(viewId);
			gripeDecorations.delete(viewId);
			editorInstances.delete(viewId);
			unregisterEditorHandle(viewId);
			editor.dispose();
			modelRegistry.release(documentId);
		};
	}, [documentId, props.api, rendered]);

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
	const diskChange = useDocumentsStore((state) =>
		documentId === undefined ? undefined : state.diskChanges[documentId],
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

	// Executed-statement gutter ticks (DataGrip-style): one glyph per
	// statement of the last run, rebuilt from document-level markers.
	// Decorations are per-editor; split views on one model each render the
	// same markers.
	const statementMarkers = useExecutionsStore((state) =>
		documentId === undefined ? undefined : state.statementMarkers[documentId],
	);
	useEffect(() => {
		const decorations = statementDecorations.get(props.api.id);
		const model = editorInstances.get(props.api.id)?.getModel();
		if (decorations === undefined || model === undefined || model === null) {
			return;
		}
		if (statementMarkers === undefined || statementMarkers.length === 0) {
			decorations.clear();
			return;
		}
		decorations.set(
			statementMarkers.map(
				(marker): monaco.editor.IModelDeltaDecoration => ({
					range: monaco.Range.fromPositions(
						model.getPositionAt(marker.start),
						model.getPositionAt(marker.end),
					),
					options: {
						glyphMarginClassName: `dg-glyph-${marker.status}`,
						glyphMarginHoverMessage: {
							value:
								marker.status === "failed" && marker.message !== undefined
									? `Statement ${marker.status}\n\n${marker.message}`
									: `Statement ${marker.status}`,
						},
						stickiness:
							monaco.editor.TrackedRangeStickiness.NeverGrowsWhenTypingAtEdges,
					},
				}),
			),
		);
	}, [statementMarkers, props.api]);

	// Gripes: re-analyse as the document changes, then render the findings
	// as gutter glyphs and squiggles. Analysis is debounced in the store;
	// the wording never enters the editor, only the location and severity.
	const documentContent = useDocumentsStore((state) =>
		documentId === undefined
			? undefined
			: state.documents[documentId]?.currentContent,
	);
	const analyse = useGripesStore((state) => state.analyse);
	useEffect(() => {
		if (documentId === undefined || documentContent === undefined) {
			return;
		}
		// The dialect is resolved from the document's connection, not
		// assumed: a rule that only applies to one engine would otherwise
		// fire on all of them.
		const connectionId = connectionIdForDocument(documentId);
		analyse(
			documentId,
			// A runbook is analysed through its `sql` fences with everything
			// else blanked out, so a `delete` with no `where` in one is a
			// blocker at the offset it actually occupies
			// (docs/spec/markdown-documents.md "SQL blocks").
			language === "markdown" ? maskNonSql(documentContent) : documentContent,
			dialectForConnection(connectionId),
			connectionId,
		);
	}, [documentId, documentContent, analyse, language]);

	// Dismissed findings must leave the gutter too, or dismissing one
	// silences the panel and leaves the squiggle arguing with it.
	const rawFindings = useGripesStore((state) =>
		documentId === undefined ? undefined : state.byDocument[documentId],
	);
	const dismissals = useGripesStore((state) => state.dismissals);
	const findings = useMemo(
		() => rawFindings?.filter((finding) => !isDismissed(finding, dismissals)),
		[rawFindings, dismissals],
	);
	useEffect(() => {
		const decorations = gripeDecorations.get(props.api.id);
		const model = editorInstances.get(props.api.id)?.getModel();
		if (decorations === undefined || model === undefined || model === null) {
			return;
		}
		if (findings === undefined || findings.length === 0) {
			decorations.clear();
			return;
		}
		const attitude = useBrandingStore
			.getState()
			.attitudeFor(useSessionStore.getState().currentWorkspaceId);
		decorations.set(
			findings.flatMap(
				(finding, index): monaco.editor.IModelDeltaDecoration[] => {
					if (finding.at.kind !== "document") {
						return [];
					}
					return [
						{
							range: monaco.Range.fromPositions(
								model.getPositionAt(finding.at.start),
								model.getPositionAt(finding.at.end),
							),
							options: {
								glyphMarginClassName: `dg-gripe-glyph-${finding.severity}`,
								className: `dg-gripe-squiggle-${finding.severity}`,
								hoverMessage: {
									value: `${renderFinding(finding, attitude, MESSAGES)}\n\n\`${renderFooter(finding)}\``,
								},
								// The annotation rail (mocks/scrollbars.html): marks
								// beside the scrollbar showing where findings are in
								// the whole document, not just the visible window.
								// Capped, because "a rail with two hundred marks is a
								// gradient, not a map". Findings are sorted worst
								// first, so the cap drops style notes before blockers.
								...(index < RAIL_CAP
									? {
											overviewRuler: {
												color: RAIL_COLOURS[finding.severity],
												position: monaco.editor.OverviewRulerLane.Right,
											},
										}
									: {}),
								stickiness:
									monaco.editor.TrackedRangeStickiness
										.NeverGrowsWhenTypingAtEdges,
							},
						},
					];
				},
			),
		);
	}, [findings, props.api]);

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

	/**
	 * A relative link in a runbook is a file in the same checkout — the
	 * case that makes a `docs/` folder worth reading in here at all
	 * (docs/spec/markdown-documents.md "Rendering").
	 *
	 * It resolves against the *directory* of the document, and a link that
	 * would climb out of the configured path is inert: `resolveInside` on
	 * the server would refuse it anyway, and refusing here means no
	 * request goes out at all.
	 */
	const openRelative = async (href: string): Promise<void> => {
		const doc =
			documentId === undefined
				? undefined
				: useDocumentsStore.getState().documents[documentId];
		const origin = doc?.origin;
		if (origin === undefined || origin === null) {
			return;
		}
		const target = resolveRelativeFile(origin.filePath, href);
		if (target === null) {
			return;
		}
		const opened = await useDocumentsStore
			.getState()
			.openFile({ ...origin, filePath: target })
			.catch(() => null);
		if (opened !== null && opened !== undefined) {
			openEditorPanel(props.containerApi, opened);
		}
	};

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
			{/* A file-backed document whose file moved on disk while this copy
				    had edits (docs/spec/datasource-paths.md). Both versions are in
				    hand; neither is adopted until someone picks, and the pick is
				    a save either way so the row, the file and every other viewer
				    end up agreeing. */}
			{diskChange !== undefined && (
				<div className="dg-conflict" role="alert">
					<span>
						This file changed on disk, and this copy has unsaved edits.
					</span>
					<button
						type="button"
						onClick={() =>
							void useDocumentsStore
								.getState()
								.resolveDiskChange(documentId, "disk")
						}
					>
						Use the file on disk
					</button>
					<button
						type="button"
						onClick={() =>
							void useDocumentsStore
								.getState()
								.resolveDiskChange(documentId, "mine")
						}
					>
						Keep this version
					</button>
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
			{rendered ? (
				<MarkdownView
					documentId={documentId}
					viewId={props.api.id}
					content={content ?? ""}
					onOpenRelative={(href) => void openRelative(href)}
				/>
			) : (
				<div ref={containerRef} className="editor-container" />
			)}
			{/* Bottom right, same place in both modes, two labels. A control
				    that moves when you press it costs people the second press. */}
			{language === "markdown" && (
				<button
					type="button"
					className="dg-md-mode"
					onClick={() => setMode(rendered ? "edit" : "view")}
				>
					{rendered ? "edit" : "view"}
				</button>
			)}
		</div>
	);
}
