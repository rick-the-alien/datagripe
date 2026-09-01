import { beforeEach, describe, expect, test } from "bun:test";
import { db } from "../persistence/db";
import type { Debouncer } from "../persistence/debounce";
import {
	createDocumentsStore,
	type DocumentsStore,
	nextUntitledIndex,
} from "./documents";

/**
 * Runs scheduled tasks synchronously and records the last returned promise
 * so tests can await persistence deterministically.
 */
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

let idCounter = 0;
let clock = 0;

function createTestStore(): {
	store: DocumentsStore;
	tracker: { last: Promise<unknown> };
} {
	const { debouncer, tracker } = createImmediateDebouncer();
	return {
		store: createDocumentsStore({
			debouncer,
			now: () => new Date(1_800_000_000_000 + clock++ * 1000).toISOString(),
			newId: () => {
				idCounter++;
				return `00000000-0000-4000-8000-${String(idCounter).padStart(12, "0")}`;
			},
		}),
		tracker,
	};
}

beforeEach(async () => {
	await Promise.all([
		db.documents.clear(),
		db.drafts.clear(),
		db.layouts.clear(),
		db.viewStates.clear(),
	]);
});

describe("documents store", () => {
	test("createDocument persists an empty saved row immediately", async () => {
		const { store, tracker } = createTestStore();
		const doc = store.getState().createDocument();
		expect(doc.title).toBe("query-1.sql");
		await tracker.last;
		const row = await db.documents.get(doc.id);
		expect(row).toMatchObject({ content: "", revision: 0 });
	});

	test("titles increment and skip used indices", () => {
		expect(nextUntitledIndex([])).toBe(1);
		expect(nextUntitledIndex(["query-1.sql", "query-2.sql"])).toBe(3);
		expect(nextUntitledIndex(["query-1.sql", "query-3.sql"])).toBe(2);
		expect(nextUntitledIndex(["notes.txt", "query-9.sql"])).toBe(1);
	});

	test("updateContent marks dirty and checkpoints a draft", async () => {
		const { store, tracker } = createTestStore();
		const doc = store.getState().createDocument();
		store.getState().updateContent(doc.id, "select 1;");
		await tracker.last;

		const updated = store.getState().documents[doc.id];
		expect(updated).toMatchObject({
			currentContent: "select 1;",
			dirty: true,
			savedContent: "",
		});
		const draft = await db.drafts.get(doc.id);
		expect(draft).toMatchObject({ content: "select 1;", baseRevision: 0 });
	});

	test("typing back to the saved content clears the dirty flag", () => {
		const { store } = createTestStore();
		const doc = store.getState().createDocument();
		store.getState().updateContent(doc.id, "select 1;");
		store.getState().updateContent(doc.id, "");
		expect(store.getState().documents[doc.id]?.dirty).toBe(false);
	});

	test("saveDocument bumps revision, persists content, deletes the draft", async () => {
		const { store, tracker } = createTestStore();
		const doc = store.getState().createDocument();
		store.getState().updateContent(doc.id, "select 1;");
		await tracker.last;

		await store.getState().saveDocument(doc.id);

		const saved = store.getState().documents[doc.id];
		expect(saved).toMatchObject({
			savedContent: "select 1;",
			revision: 1,
			dirty: false,
		});
		expect(await db.documents.get(doc.id)).toMatchObject({
			content: "select 1;",
			revision: 1,
		});
		expect(await db.drafts.get(doc.id)).toBeUndefined();
	});

	test("discardDocument removes document, draft, and view states", async () => {
		const { store, tracker } = createTestStore();
		const doc = store.getState().createDocument();
		store.getState().updateContent(doc.id, "select 1;");
		await tracker.last;
		await db.viewStates.put({
			id: "view-1",
			documentId: doc.id,
			state: {},
			updatedAt: new Date().toISOString(),
		});

		await store.getState().discardDocument(doc.id);

		expect(store.getState().documents[doc.id]).toBeUndefined();
		expect(store.getState().order).toEqual([]);
		expect(await db.documents.get(doc.id)).toBeUndefined();
		expect(await db.drafts.get(doc.id)).toBeUndefined();
		expect(await db.viewStates.get("view-1")).toBeUndefined();
	});

	test("hydrate recovers dirty drafts over saved rows", async () => {
		await db.documents.put({
			id: "11111111-1111-4111-8111-111111111111",
			title: "query-1.sql",
			content: "select 1;",
			revision: 2,
			createdAt: "2026-08-31T10:00:00.000Z",
			updatedAt: "2026-08-31T10:00:00.000Z",
		});
		await db.drafts.put({
			id: "11111111-1111-4111-8111-111111111111",
			content: "select 1; -- edited",
			baseRevision: 2,
			updatedAt: "2026-08-31T10:05:00.000Z",
		});

		const { store } = createTestStore();
		await store.getState().hydrate("ws-test");

		const doc =
			store.getState().documents["11111111-1111-4111-8111-111111111111"];
		expect(doc).toMatchObject({
			currentContent: "select 1; -- edited",
			savedContent: "select 1;",
			dirty: true,
			revision: 2,
		});
		expect(store.getState().hydrated).toBe(true);
	});
});
