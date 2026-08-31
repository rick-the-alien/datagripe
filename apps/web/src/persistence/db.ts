import Dexie, { type EntityTable } from "dexie";

/**
 * IndexedDB schema — the Phase 1 source of truth for documents and the
 * crash-recovery layer for drafts, layout, and view state.
 * See docs/spec/editor-workspace.md.
 */

export interface StoredDocument {
	id: string;
	title: string;
	content: string;
	revision: number;
	createdAt: string;
	updatedAt: string;
}

export interface StoredDraft {
	/** Document id this draft belongs to. */
	id: string;
	content: string;
	/** Document revision the draft diverged from. */
	baseRevision: number;
	updatedAt: string;
}

export interface StoredLayout {
	/** Single implicit local workspace → constant id. */
	id: string;
	json: unknown;
	updatedAt: string;
}

export interface StoredViewState {
	/** Dockview panel id. */
	id: string;
	documentId: string;
	state: unknown;
	updatedAt: string;
}

export const LOCAL_LAYOUT_ID = "local";

export const db = new Dexie("datagripe") as Dexie & {
	documents: EntityTable<StoredDocument, "id">;
	drafts: EntityTable<StoredDraft, "id">;
	layouts: EntityTable<StoredLayout, "id">;
	viewStates: EntityTable<StoredViewState, "id">;
};

db.version(1).stores({
	documents: "id, updatedAt",
	drafts: "id",
	layouts: "id",
	viewStates: "id, documentId",
});
