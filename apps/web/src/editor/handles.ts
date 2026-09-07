/**
 * Live editor handles keyed by view (panel) id — the seam run commands
 * use to read the focused editor's text, selection, and cursor without
 * coupling the executions store to Monaco.
 */
export interface EditorHandle {
	getText: () => string;
	getSelection: () => { text: string; isEmpty: boolean };
	getCursorOffset: () => number;
	/** Document offsets of the selection range, or null when empty. */
	getSelectionOffsets: () => { start: number; end: number } | null;
	/** Scroll an offset into view, put the caret on it, and focus. Used
	 * when a gripe row is clicked. */
	reveal: (offset: number) => void;
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

/**
 * Reveal an offset in whichever open view shows this document. A
 * document may be open in several views (splits); the first registered
 * one wins, which is the one the user most recently opened.
 */
export function revealInDocument(
	viewsForDocument: string[],
	offset: number,
): boolean {
	for (const viewId of viewsForDocument) {
		const handle = handles.get(viewId);
		if (handle !== undefined) {
			handle.reveal(offset);
			return true;
		}
	}
	return false;
}
