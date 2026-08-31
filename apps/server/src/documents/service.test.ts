import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { SQL } from "bun";
import { migrate } from "../db/app/migrate";
import type { AppDb } from "../db/app/pool";
import { createDocumentsService, DocumentConflictError } from "./service";

/** Documents service integration test against a real app database. */

const ADMIN_URL = "postgres://datagripe:datagripe@localhost:5432/postgres";
const SCRATCH_DB = "datagripe_documents_test";

async function probe(): Promise<boolean> {
	try {
		const sql = new SQL(ADMIN_URL, { connectionTimeout: 2 });
		await sql`SELECT 1`;
		await sql.close();
		return true;
	} catch {
		return false;
	}
}

const reachable = await probe();
const pgTest = reachable ? test : test.skip;

let appDb: AppDb;
let workspaceId: string;

beforeAll(async () => {
	if (!reachable) {
		return;
	}
	const admin = new SQL(ADMIN_URL);
	const existing =
		await admin`SELECT 1 FROM pg_database WHERE datname = ${SCRATCH_DB}`;
	if (existing.length === 0) {
		await admin.unsafe(`CREATE DATABASE ${SCRATCH_DB}`);
	}
	await admin.close();
	appDb = new SQL(
		`postgres://datagripe:datagripe@localhost:5432/${SCRATCH_DB}`,
	);
	await migrate(appDb);
	await appDb.unsafe("TRUNCATE documents, workspaces, users CASCADE");
	const users = await appDb<{ id: string }[]>`
		INSERT INTO users (email) VALUES ('docs@example.com') RETURNING id
	`;
	const workspaces = await appDb<{ id: string }[]>`
		INSERT INTO workspaces (owner_id, name) VALUES (${users[0]?.id}, 'Docs')
		RETURNING id
	`;
	workspaceId = workspaces[0]?.id ?? "";
});

afterAll(async () => {
	await appDb?.close();
});

describe("documents service", () => {
	pgTest("create, get, list round trip", async () => {
		const service = createDocumentsService(appDb);
		const created = await service.createDocument(workspaceId, {
			title: "report.sql",
			content: "select 1;",
			idempotencyKey: "docs-test-0001",
		});
		expect(created.revision).toBe(0);

		const fetched = await service.getDocument(workspaceId, created.id);
		expect(fetched.content).toBe("select 1;");

		const list = await service.listDocuments(workspaceId);
		expect(list.map((d) => d.title)).toContain("report.sql");
		expect(list[0]).not.toHaveProperty("content");
	});

	pgTest(
		"save bumps revision; stale revision conflicts with current metadata",
		async () => {
			const service = createDocumentsService(appDb);
			const doc = await service.createDocument(workspaceId, {
				title: "conflict.sql",
				content: "v1",
				idempotencyKey: "docs-test-0002",
			});
			const saved = await service.saveDocument(workspaceId, {
				id: doc.id,
				content: "v2",
				revision: 0,
				force: false,
				idempotencyKey: "docs-test-0003",
			});
			expect(saved.revision).toBe(1);
			expect(saved.content).toBe("v2");

			const conflict = await service
				.saveDocument(workspaceId, {
					id: doc.id,
					content: "stale",
					revision: 0,
					force: false,
					idempotencyKey: "docs-test-0004",
				})
				.catch((error: unknown) => error);
			expect(conflict).toBeInstanceOf(DocumentConflictError);
			expect((conflict as DocumentConflictError).current.revision).toBe(1);
			expect((conflict as DocumentConflictError).current.content).toBe("v2");
		},
	);

	pgTest("force overwrites a revision mismatch (keep-mine)", async () => {
		const service = createDocumentsService(appDb);
		const doc = await service.createDocument(workspaceId, {
			title: "force.sql",
			content: "a",
			idempotencyKey: "docs-test-0005",
		});
		await service.saveDocument(workspaceId, {
			id: doc.id,
			content: "b",
			revision: 0,
			force: false,
			idempotencyKey: "docs-test-0006",
		});
		const forced = await service.saveDocument(workspaceId, {
			id: doc.id,
			content: "mine",
			revision: 0,
			force: true,
			idempotencyKey: "docs-test-0007",
		});
		expect(forced.revision).toBe(2);
		expect(forced.content).toBe("mine");
	});

	pgTest("save renames when title is provided", async () => {
		const service = createDocumentsService(appDb);
		const doc = await service.createDocument(workspaceId, {
			title: "old.sql",
			content: "",
			idempotencyKey: "docs-test-0008",
		});
		const saved = await service.saveDocument(workspaceId, {
			id: doc.id,
			content: "",
			revision: 0,
			force: false,
			title: "new.sql",
			idempotencyKey: "docs-test-0009",
		});
		expect(saved.title).toBe("new.sql");
	});

	pgTest("archive hides from list and get", async () => {
		const service = createDocumentsService(appDb);
		const doc = await service.createDocument(workspaceId, {
			title: "gone.sql",
			content: "",
			idempotencyKey: "docs-test-0010",
		});
		await service.archiveDocument(workspaceId, doc.id);
		await expect(
			service.getDocument(workspaceId, doc.id),
		).rejects.toMatchObject({ code: "NOT_FOUND" });
		expect(
			(await service.listDocuments(workspaceId)).map((d) => d.id),
		).not.toContain(doc.id);
	});

	pgTest("documents are workspace-scoped", async () => {
		const service = createDocumentsService(appDb);
		const doc = await service.createDocument(workspaceId, {
			title: "scoped.sql",
			content: "",
			idempotencyKey: "docs-test-0011",
		});
		await expect(
			service.getDocument("00000000-0000-4000-8000-000000000099", doc.id),
		).rejects.toMatchObject({ code: "NOT_FOUND" });
	});
});
