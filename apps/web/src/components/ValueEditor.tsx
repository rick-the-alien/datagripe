import { useEffect, useRef } from "react";
import { monaco } from "../editor/monacoSetup";

/**
 * The table view's value editor (docs/spec/table-view.md "The value
 * editor"): one cell, full width of the side pane, in Monaco.
 *
 * A `jsonb` column is the reason this is an editor and not a `<pre>`.
 * Pretty-printing made a document readable; editing one needs the rest
 * of what an editor gives — folding, bracket matching, find, format —
 * and, above all, the JSON language service, so a missing comma shows up
 * as a squiggle here rather than as a failed transaction later.
 */

/** The first error in the current text, as the pane's footer says it. */
export interface ValueProblem {
	line: number;
	column: number;
	message: string;
}

export function ValueEditor(props: {
	/**
	 * Identity of the cell on show. The text is re-seeded when this
	 * changes and only then, so typing is never interrupted by the parent
	 * re-rendering with the value the editor itself just reported.
	 */
	cellKey: string;
	text: string;
	language: "json" | "plaintext";
	readOnly: boolean;
	/** Fired on every edit, and whenever the problem list changes. */
	onDraft: (text: string, problem: ValueProblem | null) => void;
}) {
	const containerRef = useRef<HTMLDivElement | null>(null);
	const editorRef = useRef<monaco.editor.IStandaloneCodeEditor | null>(null);
	/** True while we are writing the model ourselves. */
	const seedingRef = useRef(false);
	// Read inside effects that must not re-run when they change.
	const textRef = useRef(props.text);
	textRef.current = props.text;
	const onDraftRef = useRef(props.onDraft);
	onDraftRef.current = props.onDraft;

	// biome-ignore lint/correctness/useExhaustiveDependencies: the editor is created once; the props it starts from are tracked by the effects below
	useEffect(() => {
		const container = containerRef.current;
		if (container === null) {
			return;
		}
		const model = monaco.editor.createModel(
			textRef.current,
			props.language,
			// Unique per mount: the JSON worker keys diagnostics by URI, and a
			// reused URI would hand this editor the last one's markers.
			monaco.Uri.parse(`inmemory://value/${crypto.randomUUID()}`),
		);
		const editor = monaco.editor.create(container, {
			model,
			theme: "datagripe-dark",
			automaticLayout: true,
			readOnly: props.readOnly,
			minimap: { enabled: false },
			lineNumbers: "on",
			lineDecorationsWidth: 4,
			folding: true,
			wordWrap: "on",
			fontSize: 12,
			scrollBeyondLastLine: false,
			renderLineHighlight: "none",
			padding: { top: 6, bottom: 6 },
			// Middle-click drag makes the columnar, multi-line selection
			// IntelliJ does. Monaco implements it already, but hands the
			// middle button to the Linux primary clipboard instead unless
			// `selectionClipboard` is off — and a browser tab has no primary
			// clipboard to paste from, so nothing is given up.
			selectionClipboard: false,
			formatOnPaste: true,
			// A value is data, not code: no suggestion popups over it.
			quickSuggestions: false,
			// The pane is narrow, so the overview ruler is noise.
			overviewRulerLanes: 0,
			hideCursorInOverviewRuler: true,
			scrollbar: { verticalScrollbarSize: 8, horizontalScrollbarSize: 8 },
		});
		editorRef.current = editor;

		/** Report the text and the worst-placed error the model has. */
		const report = () => {
			const markers = monaco.editor
				.getModelMarkers({ resource: model.uri })
				.filter((marker) => marker.severity === monaco.MarkerSeverity.Error);
			const first = markers[0];
			onDraftRef.current(
				model.getValue(),
				first === undefined
					? null
					: {
							line: first.startLineNumber,
							column: first.startColumn,
							message: first.message,
						},
			);
		};

		const contentSubscription = model.onDidChangeContent(() => {
			if (seedingRef.current) {
				return;
			}
			report();
		});
		const markerSubscription = monaco.editor.onDidChangeMarkers((uris) => {
			if (uris.some((uri) => uri.toString() === model.uri.toString())) {
				report();
			}
		});

		return () => {
			contentSubscription.dispose();
			markerSubscription.dispose();
			editor.dispose();
			model.dispose();
			editorRef.current = null;
		};
	}, []);

	// A different cell: replace the text outright rather than diffing it,
	// and drop the undo history with it — undoing across two cells would
	// write the previous cell's value into this one.
	// biome-ignore lint/correctness/useExhaustiveDependencies: the text is seeded per cell, not tracked
	useEffect(() => {
		const model = editorRef.current?.getModel();
		if (model === undefined || model === null) {
			return;
		}
		monaco.editor.setModelLanguage(model, props.language);
		if (model.getValue() === textRef.current) {
			return;
		}
		seedingRef.current = true;
		model.setValue(textRef.current);
		seedingRef.current = false;
	}, [props.cellKey, props.language]);

	useEffect(() => {
		editorRef.current?.updateOptions({ readOnly: props.readOnly });
	}, [props.readOnly]);

	return <div className="dg-tv-side-editor" ref={containerRef} />;
}
