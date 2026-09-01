import type {
	Document,
	DocumentChangedPayload,
	DocumentListEntry,
} from "@datagripe/contracts";
import { create } from "zustand";
import { WsError, type WsRequestFn, wsClient } from "../api/ws";
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
	/** Server sync channel; absent in tests → local-only behavior. */
	ws?: { request: WsRequestFn; isOpen: () => boolean };
};

/** A save conflict: the server moved since our base revision. */
export interface DocumentConflict {
	revision: number;
	content: string;
	updatedAt: string;
}

export type DocumentsState = {
	documents: Record<string, EditorDocument>;
	/** Document ids in creation order — sidebar order. */
	order: string[];
	/** Per-document preferences (default connection) from documentPrefs. */
	prefs: Record<string, { defaultConnectionId?: string | undefined }>;
	hydrated: boolean;
	/** Workspace whose shared files are currently loaded. */
	workspaceId: string | null;
	/** Last server state seen via workspace.open (6a shared files). */
	serverDocs: Record<string, DocumentListEntry>;
	/** Documents with an unresolved save conflict (409). */
	conflicts: Record<string, DocumentConflict>;
	/** Permission/validation save failures (per document). */
	saveErrors: Record<string, string>;
	hydrate: (workspaceId: string | null) => Promise<void>;
	syncFromServer: (
		serverDocs: DocumentListEntry[],
		workspaceId: string,
	) => Promise<void>;
	/** Live incremental merge of one server-side change (document.changed). */
	applyServerChange: (change: DocumentChangedPayload) => Promise<void>;
	/** Scratchpads are local (IndexedDB); shared files sync to the server. */
	createDocument: (title?: string, shared?: boolean) => EditorDocument;
	/** Re-scope shared files to a different workspace (switch). */
	switchWorkspace: (workspaceId: string) => Promise<void>;
	renameDocument: (id: string, title: string) => void;
	updateContent: (id: string, content: string) => void;
	saveDocument: (id: string) => Promise<void>;
	resolveConflict: (id: string, choice: "reload" | "keep") => Promise<void>;
	discardDocument: (id: string) => Promise<void>;
	setDefaultConnection: (id: string, connectionId: string) => void;
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
	const { debouncer, now, newId, ws } = deps;

	/** Fetch full server document content. */
	async function fetchServerDocument(
		id: string,
	): Promise<Document | undefined> {
		if (ws === undefined || !ws.isOpen()) {
			return undefined;
		}
		try {
			const result = await ws.request<{ document: Document }>("document.get", {
				id,
			});
			return result.document;
		} catch {
			return undefined;
		}
	}

	return create<DocumentsState>()((set, get) => {
		/**
		 * Save against the server when connected, else local-only (pushed on
		 * the next sync). `baseRevision` is the revision the save guards on
		 * (force saves guard on the conflict's server revision). A CONFLICT
		 * response flags the document for the banner; transport failures fall
		 * back to the local save.
		 */
		async function saveInternal(
			doc: EditorDocument,
			baseRevision: number,
			force: boolean,
		): Promise<void> {
			// Cancel the pending checkpoint so it cannot rewrite the drafts
			// row after save deletes it.
			debouncer.cancel(doc.id);
			const onServer =
				get().serverDocs[doc.id] !== undefined || baseRevision > 0;
			let revision = baseRevision + 1;

			if (ws?.isOpen()) {
				try {
					if (onServer) {
						const result = await ws.request<{ document: Document }>(
							"document.save",
							{
								id: doc.id,
								content: doc.currentContent,
								revision: baseRevision,
								...(force ? { force: true } : {}),
								...(doc.title !== get().serverDocs[doc.id]?.title
									? { title: doc.title }
									: {}),
								idempotencyKey: crypto.randomUUID(),
							},
						);
						revision = result.document.revision;
						set({
							serverDocs: {
								...get().serverDocs,
								[doc.id]: {
									id: doc.id,
									title: result.document.title,
									revision,
									updatedAt: result.document.updatedAt,
								},
							},
						});
					} else {
						await ws.request("document.create", {
							id: doc.id,
							title: doc.title,
							content: doc.currentContent,
							idempotencyKey: crypto.randomUUID(),
						});
						revision = 0;
						set({
							serverDocs: {
								...get().serverDocs,
								[doc.id]: {
									id: doc.id,
									title: doc.title,
									revision: 0,
									updatedAt: now(),
								},
							},
						});
					}
				} catch (error) {
					if (error instanceof WsError) {
						if (error.code === "CONFLICT") {
							const details = error.details as
								| { document?: Document }
								| undefined;
							if (details?.document !== undefined) {
								set({
									conflicts: {
										...get().conflicts,
										[doc.id]: {
											revision: details.document.revision,
											content: details.document.content,
											updatedAt: details.document.updatedAt,
										},
									},
								});
								return;
							}
						}
						// Permission/validation errors are not retried silently —
						// surface them; the draft stays dirty either way.
						set({
							saveErrors: {
								...get().saveErrors,
								[doc.id]: error.message,
							},
						});
						return;
					}
					// Transport failure (socket down) → fall through to the local
					// save; the next sync pushes it (server revision stays behind).
				}
			}

			const saved: EditorDocument = {
				...doc,
				savedContent: doc.currentContent,
				revision,
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
			await db.drafts.delete(doc.id);
			set({ documents: { ...get().documents, [doc.id]: saved } });
		}

		return {
			documents: {},
			order: [],
			prefs: {},
			hydrated: false,
			workspaceId: null,
			serverDocs: {},
			conflicts: {},
			saveErrors: {},

			/** Scratchpads (local) plus this workspace's shared files. */
			async hydrate(workspaceId) {
				const [documents, drafts, prefs] = await Promise.all([
					db.documents.toArray(),
					db.drafts.toArray(),
					db.documentPrefs.toArray(),
				]);
				const scoped = documents.filter(
					(row) => row.shared !== true || row.workspaceId === workspaceId,
				);
				const scopedIds = new Set(scoped.map((row) => row.id));
				const recovered = mergeDrafts(
					scoped,
					drafts.filter((draft) => scopedIds.has(draft.id)),
				);
				set({
					documents: Object.fromEntries(recovered.map((doc) => [doc.id, doc])),
					order: recovered
						.slice()
						.sort((a, b) => a.createdAt.localeCompare(b.createdAt))
						.map((doc) => doc.id),
					prefs: Object.fromEntries(
						prefs.map((pref) => [
							pref.id,
							{ defaultConnectionId: pref.defaultConnectionId },
						]),
					),
					workspaceId,
					hydrated: true,
				});
			},

			async switchWorkspace(workspaceId) {
				if (workspaceId === get().workspaceId) {
					return;
				}
				// Drop other workspaces' shared files from memory (they stay
				// cached in IndexedDB under their workspace), keep scratchpads,
				// then load this workspace's shared files.
				const kept = Object.values(get().documents).filter(
					(doc) => !doc.shared,
				);
				const cached = await db.documents.toArray();
				const sharedRows = cached.filter(
					(row) => row.shared === true && row.workspaceId === workspaceId,
				);
				const drafts = await db.drafts.toArray();
				const keptIds = new Set([
					...kept.map((doc) => doc.id),
					...sharedRows.map((row) => row.id),
				]);
				const recovered = mergeDrafts(
					sharedRows,
					drafts.filter((draft) => keptIds.has(draft.id)),
				);
				const documents = Object.fromEntries(
					[...kept, ...recovered].map((doc) => [doc.id, doc]),
				);
				set({
					documents,
					order: Object.values(documents)
						.sort((a, b) => a.createdAt.localeCompare(b.createdAt))
						.map((doc) => doc.id),
					workspaceId,
					serverDocs: {},
					conflicts: {},
					saveErrors: {},
				});
			},

			/**
			 * Boot/reconnect merge with the shared workspace (6a). Rules:
			 * - server doc unknown locally → fetch content, add clean;
			 * - clean local doc behind server → adopt server content;
			 * - dirty local doc behind server → keep the draft, flag conflict;
			 * - local doc missing on server (rev 0) → create it server-side;
			 * - local doc ahead of server (saved offline) → push on reconnect.
			 * A dirty draft is never silently overwritten.
			 */
			async syncFromServer(serverDocs, workspaceId) {
				const serverById = new Map(serverDocs.map((doc) => [doc.id, doc]));
				const previousServer = get().serverDocs;
				set({
					serverDocs: Object.fromEntries(
						serverDocs.map((doc) => [doc.id, doc]),
					),
				});

				for (const serverDoc of serverDocs) {
					const local = get().documents[serverDoc.id];
					if (local === undefined) {
						const fetched = await fetchServerDocument(serverDoc.id);
						if (fetched === undefined) {
							continue;
						}
						const timestamp = now();
						const doc: EditorDocument = {
							id: fetched.id,
							title: fetched.title,
							language: "sql",
							savedContent: fetched.content,
							currentContent: fetched.content,
							revision: fetched.revision,
							dirty: false,
							shared: true,
							createdAt: timestamp,
							updatedAt: fetched.updatedAt,
						};
						set({
							documents: { ...get().documents, [doc.id]: doc },
							order: get().order.includes(doc.id)
								? get().order
								: [...get().order, doc.id],
						});
						void db.documents.put({
							id: doc.id,
							title: doc.title,
							content: doc.savedContent,
							revision: doc.revision,
							createdAt: doc.createdAt,
							updatedAt: doc.updatedAt,
							shared: true,
							workspaceId,
						});
						continue;
					}

					if (serverDoc.revision > local.revision) {
						const fetched = await fetchServerDocument(serverDoc.id);
						if (fetched === undefined) {
							continue;
						}
						if (!local.dirty) {
							// Clean → adopt server content wholesale.
							const adopted: EditorDocument = {
								...local,
								title: fetched.title,
								savedContent: fetched.content,
								currentContent: fetched.content,
								revision: fetched.revision,
								dirty: false,
								updatedAt: fetched.updatedAt,
							};
							set({
								documents: {
									...get().documents,
									[local.id]: adopted,
								},
							});
							debouncer.cancel(local.id);
							void db.drafts.delete(local.id);
							void db.documents.put({
								id: adopted.id,
								title: adopted.title,
								content: adopted.savedContent,
								revision: adopted.revision,
								createdAt: adopted.createdAt,
								updatedAt: adopted.updatedAt,
								shared: true,
								workspaceId,
							});
						} else {
							// Dirty → keep the draft, flag the conflict.
							set({
								documents: {
									...get().documents,
									[local.id]: {
										...local,
										savedContent: fetched.content,
										revision: fetched.revision,
									},
								},
								conflicts: {
									...get().conflicts,
									[local.id]: {
										revision: fetched.revision,
										content: fetched.content,
										updatedAt: fetched.updatedAt,
									},
								},
							});
						}
						continue;
					}

					// Local is ahead (saved while offline) → push.
					if (
						local.shared &&
						local.revision > serverDoc.revision &&
						!local.dirty &&
						previousServer[serverDoc.id] !== undefined
					) {
						await get().saveDocument(serverDoc.id);
					}

					// Repair: synced before the shared flag existed → mark shared.
					if (!local.shared && local.revision === serverDoc.revision) {
						const repaired: EditorDocument = { ...local, shared: true };
						set({
							documents: { ...get().documents, [local.id]: repaired },
						});
						void db.documents.put({
							id: repaired.id,
							title: repaired.title,
							content: repaired.savedContent,
							revision: repaired.revision,
							createdAt: repaired.createdAt,
							updatedAt: repaired.updatedAt,
							shared: true,
							workspaceId,
						});
					}
				}

				// Local SHARED documents unknown to the server → create them.
				for (const id of get().order) {
					const local = get().documents[id];
					if (
						local === undefined ||
						!local.shared ||
						serverById.has(id) ||
						local.revision > 0
					) {
						continue;
					}
					if (ws === undefined || !ws.isOpen()) {
						continue;
					}
					try {
						await ws.request("document.create", {
							id: local.id,
							title: local.title,
							content: local.savedContent,
							idempotencyKey: crypto.randomUUID(),
						});
						set({
							serverDocs: {
								...get().serverDocs,
								[local.id]: {
									id: local.id,
									title: local.title,
									revision: 0,
									updatedAt: local.updatedAt,
								},
							},
						});
					} catch {
						// Offline or rejected — next sync retries.
					}
				}
			},

			async applyServerChange(change) {
				const workspaceId = get().workspaceId;
				const local = get().documents[change.id];
				set({
					serverDocs: {
						...get().serverDocs,
						[change.id]: {
							id: change.id,
							title: change.title,
							revision: change.revision,
							updatedAt: change.updatedAt,
						},
					},
				});

				if (change.archived) {
					// Archived elsewhere: clean copies drop; dirty drafts stay put.
					if (local !== undefined && !local.dirty) {
						const { [change.id]: _gone, ...documents } = get().documents;
						set({
							documents,
							order: get().order.filter((id) => id !== change.id),
						});
						await db.documents.delete(change.id);
					}
					return;
				}

				if (local === undefined) {
					const fetched = await fetchServerDocument(change.id);
					if (fetched === undefined) {
						return;
					}
					const timestamp = now();
					const doc: EditorDocument = {
						id: fetched.id,
						title: fetched.title,
						language: "sql",
						savedContent: fetched.content,
						currentContent: fetched.content,
						revision: fetched.revision,
						dirty: false,
						shared: true,
						createdAt: timestamp,
						updatedAt: fetched.updatedAt,
					};
					set({
						documents: { ...get().documents, [doc.id]: doc },
						order: get().order.includes(doc.id)
							? get().order
							: [...get().order, doc.id],
					});
					void db.documents.put({
						id: doc.id,
						title: doc.title,
						content: doc.savedContent,
						revision: doc.revision,
						createdAt: doc.createdAt,
						updatedAt: doc.updatedAt,
						shared: true,
						workspaceId,
					});
					return;
				}

				if (!local.shared) {
					return; // a scratchpad with a colliding id is left alone
				}
				if (change.revision > local.revision) {
					const fetched = await fetchServerDocument(change.id);
					if (fetched === undefined) {
						return;
					}
					if (!local.dirty) {
						const adopted: EditorDocument = {
							...local,
							title: fetched.title,
							savedContent: fetched.content,
							currentContent: fetched.content,
							revision: fetched.revision,
							dirty: false,
							updatedAt: fetched.updatedAt,
						};
						set({
							documents: { ...get().documents, [local.id]: adopted },
						});
						debouncer.cancel(local.id);
						void db.drafts.delete(local.id);
						void db.documents.put({
							id: adopted.id,
							title: adopted.title,
							content: adopted.savedContent,
							revision: adopted.revision,
							createdAt: adopted.createdAt,
							updatedAt: adopted.updatedAt,
							shared: true,
							workspaceId,
						});
					} else {
						set({
							documents: {
								...get().documents,
								[local.id]: {
									...local,
									savedContent: fetched.content,
									revision: fetched.revision,
								},
							},
							conflicts: {
								...get().conflicts,
								[local.id]: {
									revision: fetched.revision,
									content: fetched.content,
									updatedAt: fetched.updatedAt,
								},
							},
						});
					}
				}
			},

			async resolveConflict(id, choice) {
				const conflict = get().conflicts[id];
				const local = get().documents[id];
				if (conflict === undefined || local === undefined) {
					return;
				}
				const { [id]: _cleared, ...conflicts } = get().conflicts;
				set({ conflicts });
				if (choice === "reload") {
					const adopted: EditorDocument = {
						...local,
						savedContent: conflict.content,
						currentContent: conflict.content,
						revision: conflict.revision,
						dirty: false,
						updatedAt: conflict.updatedAt,
					};
					set({ documents: { ...get().documents, [id]: adopted } });
					debouncer.cancel(id);
					await db.drafts.delete(id);
					await db.documents.put({
						id,
						title: adopted.title,
						content: adopted.savedContent,
						revision: adopted.revision,
						createdAt: adopted.createdAt,
						updatedAt: adopted.updatedAt,
					});
				} else {
					// Keep mine: force-save over the server revision.
					await saveInternal(local, conflict.revision, true);
				}
			},

			createDocument(title, shared = false) {
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
					shared,
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
					shared: doc.shared,
					workspaceId: doc.shared ? get().workspaceId : null,
				});
				// Shared files register server-side immediately when connected.
				if (shared && ws?.isOpen()) {
					void ws
						.request("document.create", {
							id: doc.id,
							title: doc.title,
							content: "",
							idempotencyKey: crypto.randomUUID(),
						})
						.then(() => {
							set({
								serverDocs: {
									...get().serverDocs,
									[doc.id]: {
										id: doc.id,
										title: doc.title,
										revision: 0,
										updatedAt: doc.updatedAt,
									},
								},
							});
						})
						.catch(() => {});
				}
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
				await saveInternal(doc, doc.revision, false);
			},

			async discardDocument(id) {
				debouncer.cancel(id);
				if (ws?.isOpen() && get().serverDocs[id] !== undefined) {
					await ws
						.request("document.archive", {
							id,
							idempotencyKey: crypto.randomUUID(),
						})
						.catch(() => {});
					const { [id]: _gone, ...serverDocs } = get().serverDocs;
					set({ serverDocs });
				}
				await Promise.all([
					db.documents.delete(id),
					db.drafts.delete(id),
					db.viewStates.where("documentId").equals(id).delete(),
					db.documentPrefs.delete(id),
				]);
				const { [id]: _removed, ...documents } = get().documents;
				const { [id]: _removedPrefs, ...prefs } = get().prefs;
				set({
					documents,
					prefs,
					order: get().order.filter((existing) => existing !== id),
				});
			},

			setDefaultConnection(id, connectionId) {
				set({
					prefs: {
						...get().prefs,
						[id]: { defaultConnectionId: connectionId },
					},
				});
				void db.documentPrefs.put({ id, defaultConnectionId: connectionId });
			},
		};
	});
}

export type DocumentsStore = ReturnType<typeof createDocumentsStore>;

export const draftDebouncer = createDebouncer();

export const useDocumentsStore = createDocumentsStore({
	debouncer: draftDebouncer,
	now: () => new Date().toISOString(),
	newId: () => crypto.randomUUID(),
	ws: { request: wsClient.request, isOpen: () => wsClient.isOpen },
});
