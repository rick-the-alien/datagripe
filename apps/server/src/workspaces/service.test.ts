import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { SQL } from "bun";
import { createAccount } from "../auth/accounts";
import { migrate } from "../db/app/migrate";
import type { AppDb } from "../db/app/pool";
import {
	createWorkspace,
	listWorkspaces,
	setDefaultConnection,
} from "./service";

/** Workspace lifecycle integration test against a real app database. */

const ADMIN_URL = "postgres://datagripe:datagripe@localhost:5432/postgres";
const SCRATCH_DB = "datagripe_workspaces_test";

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
let userId: string;

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
	await appDb.unsafe("TRUNCATE workspace_members, workspaces, users CASCADE");
	userId = (await createAccount(appDb, "ws@example.com", "hash")).userId;
});

afterAll(async () => {
	await appDb?.close();
});

describe("workspace service", () => {
	pgTest(
		"create adds an owner membership; list returns all memberships",
		async () => {
			const initial = await listWorkspaces(appDb, userId);
			expect(initial).toHaveLength(1); // default "Local" from createAccount

			const created = await createWorkspace(appDb, userId, "Analytics");
			expect(created).toMatchObject({ name: "Analytics", role: "owner" });

			const after = await listWorkspaces(appDb, userId);
			expect(after).toHaveLength(2);
			expect(after.map((w) => w.name)).toContain("Analytics");
		},
	);

	pgTest("set-default-connection validates the ref", async () => {
		const [workspace] = await listWorkspaces(appDb, userId);
		if (workspace === undefined) {
			throw new Error("expected a workspace");
		}
		const workspaceId = workspace.id;
		await setDefaultConnection(
			appDb,
			workspaceId,
			"predefined:local-demo",
			async () => true,
		);
		const rows = await appDb<{ default_connection_ref: string | null }[]>`
			SELECT default_connection_ref FROM workspaces WHERE id = ${workspaceId}
		`;
		expect(rows[0]?.default_connection_ref).toBe("predefined:local-demo");

		await expect(
			setDefaultConnection(appDb, workspaceId, "bogus", async () => false),
		).rejects.toMatchObject({ code: "NOT_FOUND" });

		await setDefaultConnection(appDb, workspaceId, null, async () => false);
		const cleared = await appDb<{ default_connection_ref: string | null }[]>`
			SELECT default_connection_ref FROM workspaces WHERE id = ${workspaceId}
		`;
		expect(cleared[0]?.default_connection_ref).toBeNull();
	});
});
