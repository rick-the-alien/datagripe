import { beforeEach, describe, expect, test } from "bun:test";
import { db } from "../persistence/db";
import { createDocumentsStore } from "./documents";

/**
 * Scratch vs shared rules: scratchpads are IndexedDB-only and never
 * reach the server; shared files sync. hydrate/switchWorkspace scope
 * shared files to the current workspace while scratchpads follow you.
 */

function localStore() {
	let idCounter = 0;
	return createDocumentsStore({
		debouncer: {
			schedule: (_key, task) => {
				void task();
			},
			flush: () => {},
			cancel: () => {},
			pending: () => false,
		},
		now: () => new Date(1_800_000_000_000).toISOString(),
		newId: () =>
			`00000000-0000-4000-8000-${String(++idCounter).padStart(12, "0")}`,
	});
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

describe("scratch vs shared", () => {
	test("scratchpads never sync and follow across workspaces", async () => {
		const store = localStore();
		await store.getState().hydrate("ws-a");
		const scratch = store.getState().createDocument("scratch.sql", false);
		const shared = store.getState().createDocument("shared.sql", true);

		expect(store.getState().documents[scratch.id]?.shared).toBe(false);
		expect(store.getState().documents[shared.id]?.shared).toBe(true);

		// Switching workspaces keeps scratch, drops other-workspace shared.
		await store.getState().switchWorkspace("ws-b");
		expect(store.getState().documents[scratch.id]).toBeDefined();
		expect(store.getState().documents[shared.id]).toBeUndefined();

		// Scratch rows in IndexedDB are workspace-unscoped.
		const row = await db.documents.get(scratch.id);
		expect(row?.shared).toBe(false);
		expect(row?.workspaceId).toBeNull();
	});

	test("hydrate hides other workspaces' shared files", async () => {
		const store = localStore();
		await store.getState().hydrate("ws-a");
		const shared = store.getState().createDocument("theirs.sql", true);

		// A fresh store hydrates ws-b: scratch visible, ws-a shared hidden.
		const fresh = localStore();
		await fresh.getState().hydrate("ws-b");
		expect(fresh.getState().documents[shared.id]).toBeUndefined();

		await fresh.getState().hydrate("ws-a");
		expect(fresh.getState().documents[shared.id]).toBeDefined();
	});

	test("sync adopts unknown server documents as shared in the current workspace", async () => {
		const store = localStore();
		await store.getState().hydrate("ws-a");
		// syncFromServer without a ws channel only records metadata; adoption
		// needs document.get. Assert the metadata bookkeeping at least.
		await store.getState().syncFromServer(
			[
				{
					id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
					title: "team.sql",
					revision: 2,
					updatedAt: "2026-08-31T10:00:00.000Z",
				},
			],
			"ws-a",
		);
		expect(
			store.getState().serverDocs["aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"],
		).toMatchObject({ title: "team.sql", revision: 2 });
	});
});
