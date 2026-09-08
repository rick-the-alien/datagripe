import {
	afterAll,
	beforeAll,
	beforeEach,
	describe,
	expect,
	test,
} from "bun:test";
import { SQL } from "bun";
import { createAccount } from "../auth/accounts";
import { migrate } from "../db/app/migrate";
import type { AppDb } from "../db/app/pool";
import { createDocumentsService } from "../documents/service";
import { createWorkspace } from "../workspaces/service";
import { getDatasourcePath, setDatasourcePaths } from "./service";
import { datasourcePathsByConnection, listDatasourcePaths } from "./store";

/**
 * Datasource path persistence against a real app database
 * (docs/spec/datasource-paths.md "Storage").
 *
 * The two rules worth testing directly rather than through the UI: a
 * kept row keeps its id — which is what stops a rename from orphaning
 * every file open from that section — and a removed row archives its
 * documents rather than deleting them.
 */

const ADMIN_URL = "postgres://datagripe:datagripe@localhost:5432/postgres";
const SCRATCH_DB = "datagripe_paths_test";
const REF = "predefined:wallet-prod";
const OTHER_REF = "predefined:wallet-analytics";

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
let otherWorkspaceId: string;

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
	await appDb.unsafe(
		"TRUNCATE datasource_paths, documents, workspace_members, workspaces, users CASCADE",
	);
	const userId = (await createAccount(appDb, "paths@example.com", "hash"))
		.userId;
	workspaceId = (await createWorkspace(appDb, userId, "Main")).id;
	otherWorkspaceId = (await createWorkspace(appDb, userId, "Other")).id;
});

afterAll(async () => {
	await appDb?.close();
});

beforeEach(async () => {
	if (!reachable) {
		return;
	}
	await appDb`DELETE FROM documents`;
	await appDb`DELETE FROM datasource_paths`;
});

let keySeed = 0;
function key(): string {
	keySeed += 1;
	return `idem-paths-${keySeed.toString().padStart(8, "0")}`;
}

describe("setDatasourcePaths", () => {
	pgTest("assigns ids and keeps the order it was given", async () => {
		const saved = await setDatasourcePaths(appDb, workspaceId, {
			connectionRef: REF,
			paths: [
				{ name: "migrations", path: "/srv/repo/db/migrations" },
				{ name: "queries", path: "/srv/repo/db/queries" },
			],
			idempotencyKey: key(),
		});
		expect(saved.map((entry) => entry.name)).toEqual(["migrations", "queries"]);
		expect(saved.every((entry) => entry.id.length > 0)).toBe(true);
	});

	pgTest("a renamed row keeps its id", async () => {
		// Otherwise every file open from that section is orphaned by a
		// typo fix, because the origin is keyed by the path id.
		const [first] = await setDatasourcePaths(appDb, workspaceId, {
			connectionRef: REF,
			paths: [{ name: "migrations", path: "/srv/repo/db" }],
			idempotencyKey: key(),
		});
		const renamed = await setDatasourcePaths(appDb, workspaceId, {
			connectionRef: REF,
			paths: [{ id: first?.id, name: "schema", path: "/srv/repo/db" }],
			idempotencyKey: key(),
		});
		expect(renamed[0]?.id).toBe(first?.id as string);
		expect(renamed[0]?.name).toBe("schema");
	});

	pgTest("two rows with the same name are refused", async () => {
		await expect(
			setDatasourcePaths(appDb, workspaceId, {
				connectionRef: REF,
				paths: [
					{ name: "queries", path: "/a" },
					{ name: "Queries", path: "/b" },
				],
				idempotencyKey: key(),
			}),
		).rejects.toThrow(/both called/);
	});

	pgTest(
		"dropping a row archives its documents rather than deleting",
		async () => {
			const documents = createDocumentsService(appDb);
			const [path] = await setDatasourcePaths(appDb, workspaceId, {
				connectionRef: REF,
				paths: [{ name: "migrations", path: "/srv/repo/db" }],
				idempotencyKey: key(),
			});
			const pathId = path?.id as string;
			const doc = await documents.createFileDocument(workspaceId, {
				origin: { connectionRef: REF, pathId, filePath: "0001.sql" },
				title: "0001.sql",
				content: "select 1;",
				diskHash: "abc",
			});
			await setDatasourcePaths(appDb, workspaceId, {
				connectionRef: REF,
				paths: [],
				idempotencyKey: key(),
			});
			const rows = await appDb<Array<{ archived_at: Date | null }>>`
			SELECT archived_at FROM documents WHERE id = ${doc.id}
		`;
			expect(rows).toHaveLength(1);
			expect(rows[0]?.archived_at).not.toBeNull();
		},
	);

	pgTest(
		"another datasource's row cannot be repointed through this one",
		async () => {
			const [mine] = await setDatasourcePaths(appDb, workspaceId, {
				connectionRef: OTHER_REF,
				paths: [{ name: "theirs", path: "/srv/theirs" }],
				idempotencyKey: key(),
			});
			await expect(
				setDatasourcePaths(appDb, workspaceId, {
					connectionRef: REF,
					paths: [{ id: mine?.id, name: "mine", path: "/srv/mine" }],
					idempotencyKey: key(),
				}),
			).rejects.toThrow(/no longer exists/);
		},
	);

	pgTest("paths are scoped to their workspace", async () => {
		await setDatasourcePaths(appDb, workspaceId, {
			connectionRef: REF,
			paths: [{ name: "migrations", path: "/srv/repo/db" }],
			idempotencyKey: key(),
		});
		await expect(
			listDatasourcePaths(appDb, otherWorkspaceId, REF),
		).resolves.toEqual([]);
	});
});

describe("lookup", () => {
	pgTest("groups by connection ref for the connection list", async () => {
		await setDatasourcePaths(appDb, workspaceId, {
			connectionRef: REF,
			paths: [{ name: "a", path: "/a" }],
			idempotencyKey: key(),
		});
		await setDatasourcePaths(appDb, workspaceId, {
			connectionRef: OTHER_REF,
			paths: [{ name: "b", path: "/b" }],
			idempotencyKey: key(),
		});
		const byRef = await datasourcePathsByConnection(appDb, workspaceId);
		expect(byRef.get(REF)?.map((entry) => entry.name)).toEqual(["a"]);
		expect(byRef.get(OTHER_REF)?.map((entry) => entry.name)).toEqual(["b"]);
	});

	pgTest("a path from another workspace is not found", async () => {
		const [path] = await setDatasourcePaths(appDb, workspaceId, {
			connectionRef: REF,
			paths: [{ name: "a", path: "/a" }],
			idempotencyKey: key(),
		});
		await expect(
			getDatasourcePath(appDb, otherWorkspaceId, path?.id as string),
		).rejects.toThrow(/no longer exists/);
	});
});
