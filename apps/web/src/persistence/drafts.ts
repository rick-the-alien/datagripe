import { z } from "zod";
import type { StoredDocument, StoredDraft } from "./db";

/**
 * Boot-time recovery merge. Pure so it is unit-testable without IndexedDB.
 * Rule: a draft newer than its document's saved row always wins — a crash
 * must never silently discard typed content.
 */

export const recoveredDocumentSchema = z.object({
	id: z.uuid(),
	title: z.string().min(1).max(255),
	language: z.literal("sql"),
	savedContent: z.string(),
	currentContent: z.string(),
	revision: z.number().int().nonnegative(),
	dirty: z.boolean(),
	createdAt: z.iso.datetime(),
	updatedAt: z.iso.datetime(),
});

export type RecoveredDocument = z.infer<typeof recoveredDocumentSchema>;

export function mergeDrafts(
	documents: StoredDocument[],
	drafts: StoredDraft[],
): RecoveredDocument[] {
	const draftsByDocument = new Map(drafts.map((draft) => [draft.id, draft]));
	const recovered: RecoveredDocument[] = [];

	for (const doc of documents) {
		const draft = draftsByDocument.get(doc.id);
		const draftWins = draft !== undefined && draft.updatedAt > doc.updatedAt;
		recovered.push({
			id: doc.id,
			title: doc.title,
			language: "sql",
			savedContent: doc.content,
			currentContent: draftWins ? draft.content : doc.content,
			revision: doc.revision,
			dirty: draftWins,
			createdAt: doc.createdAt,
			updatedAt: draftWins ? draft.updatedAt : doc.updatedAt,
		});
	}

	// Documents created but never saved (no documents row yet) survive only
	// if their draft exists; a draft without a document row is restored as an
	// unsaved document so nothing typed is lost.
	const known = new Set(documents.map((doc) => doc.id));
	for (const draft of drafts) {
		if (known.has(draft.id)) {
			continue;
		}
		recovered.push({
			id: draft.id,
			title: "recovered.sql",
			language: "sql",
			savedContent: "",
			currentContent: draft.content,
			revision: draft.baseRevision,
			dirty: true,
			createdAt: draft.updatedAt,
			updatedAt: draft.updatedAt,
		});
	}

	return recovered;
}
