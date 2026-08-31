import { describe, expect, test } from "bun:test";
import type { StoredDocument, StoredDraft } from "./db";
import { mergeDrafts } from "./drafts";

const DOC_ID = "11111111-1111-4111-8111-111111111111";
const OTHER_ID = "22222222-2222-4222-8222-222222222222";

function storedDoc(overrides: Partial<StoredDocument> = {}): StoredDocument {
	return {
		id: DOC_ID,
		title: "query-1.sql",
		content: "select 1;",
		revision: 3,
		createdAt: "2026-08-31T10:00:00.000Z",
		updatedAt: "2026-08-31T10:00:00.000Z",
		...overrides,
	};
}

function storedDraft(overrides: Partial<StoredDraft> = {}): StoredDraft {
	return {
		id: DOC_ID,
		content: "select 2; -- unsaved",
		baseRevision: 3,
		updatedAt: "2026-08-31T10:05:00.000Z",
		...overrides,
	};
}

describe("mergeDrafts", () => {
	test("no draft → clean document with saved content", () => {
		const [doc] = mergeDrafts([storedDoc()], []);
		expect(doc).toMatchObject({
			currentContent: "select 1;",
			savedContent: "select 1;",
			dirty: false,
			revision: 3,
		});
	});

	test("newer draft wins over saved content", () => {
		const [doc] = mergeDrafts([storedDoc()], [storedDraft()]);
		expect(doc).toMatchObject({
			currentContent: "select 2; -- unsaved",
			savedContent: "select 1;",
			dirty: true,
			updatedAt: "2026-08-31T10:05:00.000Z",
		});
	});

	test("stale draft (older than the save) does not overwrite", () => {
		const draft = storedDraft({ updatedAt: "2026-08-31T09:00:00.000Z" });
		const [doc] = mergeDrafts([storedDoc()], [draft]);
		expect(doc).toMatchObject({ currentContent: "select 1;", dirty: false });
	});

	test("draft without a document row survives as an unsaved document", () => {
		const orphan = storedDraft({ id: OTHER_ID, content: "select 99;" });
		const recovered = mergeDrafts([storedDoc()], [orphan]);
		expect(recovered).toHaveLength(2);
		const restored = recovered.find((doc) => doc.id === OTHER_ID);
		expect(restored).toMatchObject({
			currentContent: "select 99;",
			dirty: true,
			title: "recovered.sql",
		});
	});

	test("draft equal to the document timestamp does not win", () => {
		const at = "2026-08-31T10:00:00.000Z";
		const [doc] = mergeDrafts(
			[storedDoc({ updatedAt: at })],
			[storedDraft({ updatedAt: at })],
		);
		expect(doc?.dirty).toBe(false);
	});
});
