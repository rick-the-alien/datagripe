import type { ViewStatePayload } from "@datagripe/contracts";
import type { monaco } from "./monacoSetup";

/**
 * Remote cursor/selection rendering (docs/spec/multiplayer.md 6c):
 * decorations only — the server stores nothing, edits never merge.
 * Colors derive from the user id so each member is visually stable.
 */

type Monaco = typeof monaco;
type Decoration = import("monaco-editor").editor.IModelDeltaDecoration;

export function userColor(userId: string): string {
	let hash = 0;
	for (let i = 0; i < userId.length; i++) {
		hash = (hash * 31 + userId.charCodeAt(i)) >>> 0;
	}
	return `hsl(${hash % 360} 70% 65%)`;
}

const styleSheets = new Map<string, string>();

function cursorClassName(userId: string): string {
	const color = userColor(userId);
	let className = styleSheets.get(userId);
	if (className !== undefined) {
		return className;
	}
	className = `dg-remote-cursor-${styleSheets.size}`;
	const style = document.createElement("style");
	style.textContent = `
		.${className} { border-left: 2px solid ${color}; margin-left: -1px; }
		.${className}-selection { background: ${color.replace("65%)", "65% / 0.25)")}; }
	`;
	document.head.appendChild(style);
	styleSheets.set(userId, className);
	return className;
}

export function remoteViewDecorations(
	monacoNs: Monaco,
	view: ViewStatePayload,
): Decoration[] {
	const className = cursorClassName(view.userId);
	const decorations: Decoration[] = [
		{
			range: new monacoNs.Range(
				view.cursor.line,
				view.cursor.column,
				view.cursor.line,
				view.cursor.column,
			),
			options: {
				className,
				stickiness: 1,
				hoverMessage: { value: "remote cursor" },
			},
		},
	];
	if (view.selection !== null) {
		decorations.push({
			range: new monacoNs.Range(
				view.selection.startLine,
				view.selection.startColumn,
				view.selection.endLine,
				view.selection.endColumn,
			),
			options: {
				className: `${className}-selection`,
				stickiness: 1,
			},
		});
	}
	return decorations;
}
