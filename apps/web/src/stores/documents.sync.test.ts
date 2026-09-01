import { beforeEach, describe, expect, test } from "bun:test";
import type { Document, DocumentListEntry } from "@datagripe/contracts";
import { WsError, type WsRequestFn } from "../api/ws";
import { db } from "../persistence/db";
import type { Debouncer } from "../persistence/debounce";
import { createDocumentsStore } from "./documents";

/** Server-sync behavior of the documents store with a scripted WS channel. */

let idCounter = 0;
let clock = 0;

function createImmediateDebouncer() {
	const tracker = { last: Promise.resolve() as Promise<unknown> };
	const debouncer: Debouncer = {
		schedule: (_key, task) => {
			tracker.last = Promise.resolve(task());
		},
		flush: () => {},
		cancel: () => {},
		pending: () => false,
	};
	return { debouncer, tracker };
}

interface FakeServer {
	documents: Map<string, Document>;
	requestLog: Array<{ action: string; payload: unknown }>;
}

function makeWs(server: FakeServer) {
	const request: WsRequestFn = async <T>(action: string, payload: unknown) => {
		server.requestLog.push({ action, payload });
		const body = payload as Record<string, unknown>;
		if (action === "document.get") {
			const doc = server.documents.get(body.id as string);
			if (doc === undefined) {
				throw new WsError("NOT_FOUND", "not found");
			}
			return { document: doc } as T;
		}
		if (action === "document.create") {
			const existing = server.documents.get(body.id as string);
			if (existing !== undefined) {
				return { document: existing } as T;
			}
			const doc: Document = {
				id: body.id as string,
				workspaceId: "ws-1",
				title: body.title as string,
				language: "sql",
				content: body.content as string,
				revision: 0,
				updatedAt: new Date().toISOString(),
			};
			server.documents.set(doc.id, doc);
			return { document: doc } as T;
		}
		if (action === "document.save") {
			const doc = server.documents.get(body.id as string);
			if (doc === undefined) {
				throw new WsError("NOT_FOUND", "not found");
			}
			if (doc.revision !== body.revision && body.force !== true) {
				throw new WsError("CONFLICT", "conflict", { document: doc });
			}
			const saved: Document = {
				...doc,
				content: body.content as string,
				title: (body.title as string) ?? doc.title,
				revision: doc.revision + 1,
				updatedAt: new Date().toISOString(),
			};
			server.documents.set(doc.id, saved);
			return { document: saved } as T;
		}
		if (action === "document.archive") {
			server.documents.delete(body.id as string);
			return {} as T;
		}
		throw new Error(`unexpected action ${action}`);
	};
	return { request, isOpen: () => true };
}

function serverEntry(doc: Document): DocumentListEntry {
	return {
		id: doc.id,
		title: doc.title,
		revision: doc.revision,
		updatedAt: doc.updatedAt,
	};
}

function createSyncedStore(server: FakeServer) {
	const { debouncer, tracker } = createImmediateDebouncer();
	const store = createDocumentsStore({
		debouncer,
		now: () => new Date(1_800_000_000_000 + clock++ * 1000).toISOString(),
		newId: () => {
			idCounter++;
			return `00000000-0000-4000-8000-${String(idCounter).padStart(12, "0")}`;
		},
		ws: makeWs(server),
	});
	return { store, tracker };
}

beforeEach(async () => {
	await Promise.all([
		db.documents.clear(),
		db.drafts.clear(),
		db.layouts.clear(),
		db.viewStates.clear(),
		db.documentPrefs.clear(),
	]);
});

describe("documents server sync", () => {
	test("unknown server document is fetched and added clean", async () => {
		const server: FakeServer = { documents: new Map(), requestLog: [] };
		const { store } = createSyncedStore(server);
		const serverDoc: Document = {
			id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
			workspaceId: "ws-1",
			title: "shared.sql",
			language: "sql",
			content: "select 42;",
			revision: 3,
			updatedAt: "2026-08-31T10:00:00.000Z",
		};
		server.documents.set(serverDoc.id, serverDoc);

		await store.getState().hydrate("ws-test");
		await store.getState().syncFromServer([serverEntry(serverDoc)], "ws-test");

		const doc = store.getState().documents[serverDoc.id];
		expect(doc).toMatchObject({
			title: "shared.sql",
			currentContent: "select 42;",
			revision: 3,
			dirty: false,
		});
		expect(await db.documents.get(serverDoc.id)).toMatchObject({
			content: "select 42;",
			revision: 3,
		});
	});

	test("dirty local draft wins over a newer server revision, flagged as conflict", async () => {
		const server: FakeServer = { documents: new Map(), requestLog: [] };
		const { store, tracker } = createSyncedStore(server);
		const doc = store.getState().createDocument("mine.sql");
		// Server knows it at revision 0.
		await store.getState().saveDocument(doc.id);
		expect(server.documents.get(doc.id)?.revision).toBe(0);

		// Someone else saves revision 1.
		server.documents.set(doc.id, {
			...(server.documents.get(doc.id) as Document),
			content: "theirs",
			revision: 1,
			updatedAt: "2026-08-31T11:00:00.000Z",
		});
		// I have unsaved local edits.
		store.getState().updateContent(doc.id, "mine -- unsaved");
		await tracker.last;

		await store
			.getState()
			.syncFromServer(
				[serverEntry(server.documents.get(doc.id) as Document)],
				"ws-test",
			);

		const after = store.getState().documents[doc.id];
		expect(after?.currentContent).toBe("mine -- unsaved");
		expect(after?.dirty).toBe(true);
		expect(store.getState().conflicts[doc.id]?.revision).toBe(1);
		expect(store.getState().conflicts[doc.id]?.content).toBe("theirs");
	});

	test("clean local doc adopts the newer server revision", async () => {
		const server: FakeServer = { documents: new Map(), requestLog: [] };
		const { store } = createSyncedStore(server);
		const doc = store.getState().createDocument("clean.sql");
		await store.getState().saveDocument(doc.id);

		server.documents.set(doc.id, {
			...(server.documents.get(doc.id) as Document),
			content: "server-moved",
			revision: 1,
			updatedAt: "2026-08-31T11:00:00.000Z",
		});
		await store
			.getState()
			.syncFromServer(
				[serverEntry(server.documents.get(doc.id) as Document)],
				"ws-test",
			);

		const after = store.getState().documents[doc.id];
		expect(after).toMatchObject({
			currentContent: "server-moved",
			savedContent: "server-moved",
			revision: 1,
			dirty: false,
		});
		expect(store.getState().conflicts[doc.id]).toBeUndefined();
	});

	test("save through the server bumps revision from the response", async () => {
		const server: FakeServer = { documents: new Map(), requestLog: [] };
		const { store, tracker } = createSyncedStore(server);
		const doc = store.getState().createDocument("synced.sql");
		await store.getState().saveDocument(doc.id); // creates server-side (rev 0)

		store.getState().updateContent(doc.id, "select 1;");
		await tracker.last;
		await store.getState().saveDocument(doc.id);

		expect(server.documents.get(doc.id)).toMatchObject({
			content: "select 1;",
			revision: 1,
		});
		expect(store.getState().documents[doc.id]).toMatchObject({
			revision: 1,
			dirty: false,
		});
	});

	test("a 409 flags the conflict and keeps the draft dirty", async () => {
		const server: FakeServer = { documents: new Map(), requestLog: [] };
		const { store, tracker } = createSyncedStore(server);
		const doc = store.getState().createDocument("clash.sql");
		await store.getState().saveDocument(doc.id);

		// Server moves on without us.
		server.documents.set(doc.id, {
			...(server.documents.get(doc.id) as Document),
			revision: 1,
			content: "elsewhere",
			updatedAt: "2026-08-31T11:00:00.000Z",
		});
		// We never synced that move; our base is still 0.
		store.getState().updateContent(doc.id, "mine");
		await tracker.last;
		await store.getState().saveDocument(doc.id);

		const after = store.getState().documents[doc.id];
		expect(after?.dirty).toBe(true);
		expect(store.getState().conflicts[doc.id]?.content).toBe("elsewhere");
		expect(server.documents.get(doc.id)?.content).toBe("elsewhere");
	});

	test("resolveConflict keep force-saves; reload adopts the server content", async () => {
		const server: FakeServer = { documents: new Map(), requestLog: [] };
		const { store, tracker } = createSyncedStore(server);
		const doc = store.getState().createDocument("pick.sql");
		await store.getState().saveDocument(doc.id);
		server.documents.set(doc.id, {
			...(server.documents.get(doc.id) as Document),
			revision: 1,
			content: "theirs",
			updatedAt: "2026-08-31T11:00:00.000Z",
		});
		store.getState().updateContent(doc.id, "mine");
		await tracker.last;
		await store.getState().saveDocument(doc.id);
		expect(store.getState().conflicts[doc.id]).toBeDefined();

		// keep-mine: force over revision 1.
		await store.getState().resolveConflict(doc.id, "keep");
		expect(server.documents.get(doc.id)?.content).toBe("mine");
		expect(store.getState().documents[doc.id]?.dirty).toBe(false);
		expect(store.getState().conflicts[doc.id]).toBeUndefined();

		// Set up another conflict and reload instead.
		server.documents.set(doc.id, {
			...(server.documents.get(doc.id) as Document),
			revision: 5,
			content: "server-v5",
			updatedAt: "2026-08-31T12:00:00.000Z",
		});
		store.getState().updateContent(doc.id, "mine-again");
		await tracker.last;
		await store.getState().saveDocument(doc.id);
		await store.getState().resolveConflict(doc.id, "reload");
		expect(store.getState().documents[doc.id]).toMatchObject({
			currentContent: "server-v5",
			revision: 5,
			dirty: false,
		});
	});

	test("discard archives a server-known document", async () => {
		const server: FakeServer = { documents: new Map(), requestLog: [] };
		const { store } = createSyncedStore(server);
		const doc = store.getState().createDocument("gone.sql");
		await store.getState().saveDocument(doc.id);

		await store.getState().discardDocument(doc.id);
		expect(server.documents.has(doc.id)).toBe(false);
		expect(server.requestLog.some((r) => r.action === "document.archive")).toBe(
			true,
		);
	});
});
