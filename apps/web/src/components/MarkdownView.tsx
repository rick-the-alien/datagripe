import { useEffect, useMemo, useRef, useState } from "react";
import { type MarkdownSegment, scanMarkdown } from "../editor/markdown/blocks";
import { renderMarkdown } from "../editor/markdown/render";
import { monaco } from "../editor/monacoSetup";
import {
	connectionIdForDocument,
	dialectForConnection,
} from "../stores/documentConnection";
import { useDocumentsStore } from "../stores/documents";
import { useExecutionsStore } from "../stores/runtime";
import { IconRun } from "./icons";

/**
 * A markdown document, rendered (docs/spec/markdown-documents.md).
 *
 * A `.md` in a database repository is a runbook: prose that explains
 * what the nightly job does, and then the query you run when it fails.
 * That query is executable where it is written, which is the whole point
 * — otherwise it is read in one window and retyped in another, and drifts
 * from the prose that explains it.
 */

export interface MarkdownViewProps {
	documentId: string;
	viewId: string;
	content: string;
	/** Clicking a relative link opens that file, when the pane can. */
	onOpenRelative?: (href: string) => void;
}

export function MarkdownView(props: MarkdownViewProps) {
	const segments = useMemo(() => scanMarkdown(props.content), [props.content]);

	return (
		<div className="dg-md-view dg-scroll">
			{segments.map((segment) =>
				segment.kind === "code" && segment.sql ? (
					<SqlBlock
						key={`${segment.start}-${segment.end}`}
						segment={segment}
						documentId={props.documentId}
						viewId={props.viewId}
					/>
				) : (
					<Prose
						key={`${segment.start}-${segment.end}`}
						segment={segment}
						{...(props.onOpenRelative !== undefined
							? { onOpenRelative: props.onOpenRelative }
							: {})}
					/>
				),
			)}
		</div>
	);
}

function Prose(props: {
	segment: MarkdownSegment;
	onOpenRelative?: (href: string) => void;
}) {
	// Memoised on the text: a markdown document under a debounced gripe
	// runner would otherwise re-parse on every keystroke.
	const html = useMemo(
		() => renderMarkdown(props.segment.text),
		[props.segment.text],
	);
	const onOpenRelative = props.onOpenRelative;

	/*
	 * The click handler is delegation, not an interaction of its own: the
	 * things it responds to are anchors inside the rendered HTML, which
	 * are focusable and activate on Enter already.
	 */
	return (
		// biome-ignore lint/a11y/noStaticElementInteractions: delegating to anchors inside, which are already focusable
		// biome-ignore lint/a11y/useKeyWithClickEvents: as above — the anchors carry the keyboard behaviour
		<div
			className="dg-md-prose"
			onClick={(event) => {
				const anchor = (event.target as HTMLElement).closest("a[data-dg-path]");
				if (anchor === null) {
					return;
				}
				// A relative link is a file in the checkout, not a URL. The
				// renderer left the path here rather than an href precisely so
				// the browser never tries to navigate to it.
				event.preventDefault();
				onOpenRelative?.(anchor.getAttribute("data-dg-path") ?? "");
			}}
			/*
			 * Safe by construction rather than by filtering: `renderMarkdown`
			 * escapes every piece of raw HTML in the source instead of
			 * sanitizing it afterwards, so there is no filter to keep ahead of
			 * an attacker (docs/spec/markdown-documents.md "Rendering").
			 * Asserted in render.test.ts.
			 */
			// biome-ignore lint/security/noDangerouslySetInnerHtml: renderMarkdown escapes raw HTML; see render.test.ts
			dangerouslySetInnerHTML={{ __html: html }}
		/>
	);
}

/**
 * One runnable block: a read-only Monaco instance, not a `<pre>`.
 *
 * It costs a model and buys the exact tokenizer, theme and font the
 * editor uses, which is what makes the block read as *the same SQL* as
 * the tab next door. Created when it scrolls into view and disposed on
 * unmount, because a forty-block runbook should not be forty editors on
 * open.
 */
function SqlBlock(props: {
	segment: MarkdownSegment;
	documentId: string;
	viewId: string;
}) {
	const hostRef = useRef<HTMLDivElement>(null);
	const [visible, setVisible] = useState(false);
	// Subscribed to prefs so choosing a connection in the results panel
	// enables the run button without a remount.
	useDocumentsStore((state) => state.prefs[props.documentId]);
	const connectionId = connectionIdForDocument(props.documentId);
	const runError = useExecutionsStore(
		(state) => state.runErrors[props.documentId],
	);

	useEffect(() => {
		const host = hostRef.current;
		if (host === null || visible) {
			return;
		}
		const observer = new IntersectionObserver((entries) => {
			if (entries.some((entry) => entry.isIntersecting)) {
				setVisible(true);
				observer.disconnect();
			}
		});
		observer.observe(host);
		return () => observer.disconnect();
	}, [visible]);

	useEffect(() => {
		const host = hostRef.current;
		if (host === null || !visible) {
			return;
		}
		const editor = monaco.editor.create(host, {
			value: props.segment.text,
			language: "sql",
			readOnly: true,
			// A block is part of a document, not a window into one: no
			// minimap, no ruler, no scrollbar of its own. It grows to fit.
			automaticLayout: true,
			minimap: { enabled: false },
			lineNumbers: "off",
			glyphMargin: false,
			folding: false,
			renderLineHighlight: "none",
			overviewRulerLanes: 0,
			scrollBeyondLastLine: false,
			scrollbar: { vertical: "hidden", horizontal: "auto" },
			wordWrap: "on",
			contextmenu: false,
			fontSize: 13,
			padding: { top: 8, bottom: 8 },
		});
		const lines = editor.getModel()?.getLineCount() ?? 1;
		host.style.height = `${Math.max(lines, 1) * 19 + 16}px`;
		return () => {
			editor.getModel()?.dispose();
			editor.dispose();
		};
	}, [visible, props.segment.text]);

	const dialect =
		connectionId === undefined ? undefined : dialectForConnection(connectionId);

	return (
		<div className="dg-md-block">
			<div className="dg-md-block-bar">
				<span className="dg-md-block-lang">{props.segment.info}</span>
				{dialect !== undefined && (
					<span className="dg-md-block-dialect">{dialect}</span>
				)}
				<button
					type="button"
					className="dg-md-block-run"
					disabled={connectionId === undefined}
					title={
						connectionId === undefined
							? "Choose a connection for this document (Results panel)."
							: "Run this block"
					}
					onClick={() =>
						void useExecutionsStore.getState().run(props.viewId, "auto", {
							sql: props.segment.text,
							start: props.segment.start,
							end: props.segment.end,
						})
					}
				>
					<IconRun /> run
				</button>
			</div>
			<div ref={hostRef} className="dg-md-block-editor">
				{!visible && <pre className="dg-md-code">{props.segment.text}</pre>}
			</div>
			{runError !== undefined && (
				<p className="dg-md-block-error">{runError}</p>
			)}
		</div>
	);
}
