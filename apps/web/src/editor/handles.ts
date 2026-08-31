/**
 * Live editor handles keyed by view (panel) id — the seam run commands
 * use to read the focused editor's text, selection, and cursor without
 * coupling the executions store to Monaco.
 */
export interface EditorHandle {
	getText: () => string;
	getSelection: () => { text: string; isEmpty: boolean };
	getCursorOffset: () => number;
}

const handles = new Map<string, EditorHandle>();

export function registerEditorHandle(
	viewId: string,
	handle: EditorHandle,
): void {
	handles.set(viewId, handle);
}

export function unregisterEditorHandle(viewId: string): void {
	handles.delete(viewId);
}

export function getEditorHandle(viewId: string): EditorHandle | undefined {
	return handles.get(viewId);
}
