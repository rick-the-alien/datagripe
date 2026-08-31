import { create } from "zustand";
import { db } from "../persistence/db";
import { createDebouncer, type Debouncer } from "../persistence/debounce";
import { mergeDrafts, type RecoveredDocument } from "../persistence/drafts";

/**
 * Document store — authoritative for document domain state
 * (docs/spec/editor-workspace.md). IndexedDB writes are fire-and-forget
 * from the mutation methods; the merge with drafts happens once in
 * `hydrate` at boot.
 */

export type EditorDocument = RecoveredDocument;

export type DocumentsStoreDeps = {
	debouncer: Debouncer;
	now: () => string;
	newId: () => string;
};

export type DocumentsState = {
	documents: Record<string, EditorDocument>;
	/** Document ids in creation order — sidebar order. */
	order: string[];
	hydrated: boolean;
	hydrate: () => Promise<void>;
	createDocument: (title?: string) => EditorDocument;
	renameDocument: (id: string, title: string) => void;
	updateContent: (id: string, content: string) => void;
	saveDocument: (id: string) => Promise<void>;
	discardDocument: (id: string) => Promise<void>;
};

export const DRAFT_CHECKPOINT_DELAY_MS = 750;

/** Checkpoint one document's current content into the drafts table. */
export async function checkpointDraft(doc: EditorDocument): Promise<void> {
	await db.drafts.put({
		id: doc.id,
		content: doc.currentContent,
		baseRevision: doc.revision,
		updatedAt: doc.updatedAt,
	});
}

export function nextUntitledIndex(titles: Iterable<string>): number {
	const used = new Set<number>();
	for (const title of titles) {
		const match = /^query-(\d+)\.sql$/.exec(title);
		if (match?.[1] !== undefined) {
			used.add(Number(match[1]));
		}
	}
	let candidate = 1;
	while (used.has(candidate)) {
		candidate++;
	}
	return candidate;
}

export function createDocumentsStore(deps: DocumentsStoreDeps) {
	const { debouncer, now, newId } = deps;

	return create<DocumentsState>()((set, get) => ({
		documents: {},
		order: [],
		hydrated: false,

		async hydrate() {
			const [documents, drafts] = await Promise.all([
				db.documents.toArray(),
				db.drafts.toArray(),
			]);
			const recovered = mergeDrafts(documents, drafts);
			set({
				documents: Object.fromEntries(recovered.map((doc) => [doc.id, doc])),
				order: recovered
					.slice()
					.sort((a, b) => a.createdAt.localeCompare(b.createdAt))
					.map((doc) => doc.id),
				hydrated: true,
			});
		},

		createDocument(title) {
			const state = get();
			const resolvedTitle =
				title ??
				`query-${nextUntitledIndex(
					state.order.map((id) => state.documents[id]?.title ?? ""),
				)}.sql`;
			const timestamp = now();
			const doc: EditorDocument = {
				id: newId(),
				title: resolvedTitle,
				language: "sql",
				savedContent: "",
				currentContent: "",
				revision: 0,
				dirty: false,
				createdAt: timestamp,
				updatedAt: timestamp,
			};
			set({
				documents: { ...state.documents, [doc.id]: doc },
				order: [...state.order, doc.id],
			});
			// Persist immediately so the document survives reload even before
			// the first keystroke.
			void db.documents.put({
				id: doc.id,
				title: doc.title,
				content: "",
				revision: 0,
				createdAt: doc.createdAt,
				updatedAt: doc.updatedAt,
			});
			return doc;
		},

		renameDocument(id, title) {
			const doc = get().documents[id];
			if (doc === undefined || title.length === 0) {
				return;
			}
			const renamed = { ...doc, title, updatedAt: now() };
			set({ documents: { ...get().documents, [id]: renamed } });
			void db.documents.update(id, { title, updatedAt: renamed.updatedAt });
		},

		updateContent(id, content) {
			const doc = get().documents[id];
			if (doc === undefined || doc.currentContent === content) {
				return;
			}
			const updated: EditorDocument = {
				...doc,
				currentContent: content,
				dirty: content !== doc.savedContent,
				updatedAt: now(),
			};
			set({ documents: { ...get().documents, [id]: updated } });
			debouncer.schedule(
				id,
				() => checkpointDraft(updated),
				DRAFT_CHECKPOINT_DELAY_MS,
			);
		},

		async saveDocument(id) {
			const doc = get().documents[id];
			if (doc === undefined) {
				return;
			}
			// Cancel the pending checkpoint so it cannot rewrite the drafts
			// row after save deletes it.
			debouncer.cancel(id);
			const saved: EditorDocument = {
				...doc,
				savedContent: doc.currentContent,
				revision: doc.revision + 1,
				dirty: false,
				updatedAt: now(),
			};
			// Order matters: document row first, then draft delete. A crash
			// between the two leaves a recoverable draft, never a lost save.
			await db.documents.put({
				id: saved.id,
				title: saved.title,
				content: saved.savedContent,
				revision: saved.revision,
				createdAt: saved.createdAt,
				updatedAt: saved.updatedAt,
			});
			await db.drafts.delete(id);
			set({ documents: { ...get().documents, [id]: saved } });
		},

		async discardDocument(id) {
			debouncer.cancel(id);
			await Promise.all([
				db.documents.delete(id),
				db.drafts.delete(id),
				db.viewStates.where("documentId").equals(id).delete(),
			]);
			const { [id]: _removed, ...documents } = get().documents;
			set({
				documents,
				order: get().order.filter((existing) => existing !== id),
			});
		},
	}));
}

export type DocumentsStore = ReturnType<typeof createDocumentsStore>;

export const draftDebouncer = createDebouncer();

export const useDocumentsStore = createDocumentsStore({
	debouncer: draftDebouncer,
	now: () => new Date().toISOString(),
	newId: () => crypto.randomUUID(),
});
