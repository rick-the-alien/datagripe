import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { SQL } from "bun";
import { ensureLocalWorkspace } from "../bootstrap";
import { migrate } from "../db/app/migrate";
import type { AppDb } from "../db/app/pool";
import { createAccount, defaultWorkspaceFor } from "./accounts";

/** Stub-workspace inheritance: exactly one account inherits (ADR 0002). */

const ADMIN_URL = "postgres://datagripe:datagripe@localhost:5432/postgres";
const SCRATCH_DB = "datagripe_inherit_test";

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
});

afterAll(async () => {
	await appDb?.close();
});

describe("stub workspace inheritance", () => {
	pgTest(
		"first account inherits the stub workspace; second gets its own",
		async () => {
			const stub = await ensureLocalWorkspace(appDb);

			const first = await createAccount(appDb, "first@example.com", "hash");
			expect(first.workspaceId).toBe(stub.workspace.id);
			const firstWs = await defaultWorkspaceFor(appDb, first.userId);
			expect(firstWs).toMatchObject({ id: stub.workspace.id, role: "owner" });

			const second = await createAccount(appDb, "second@example.com", "hash");
			expect(second.workspaceId).not.toBe(stub.workspace.id);
			const secondWs = await defaultWorkspaceFor(appDb, second.userId);
			expect(secondWs?.id).toBe(second.workspaceId);

			// The second account has no membership in the stub workspace.
			const stray = await appDb`
			SELECT 1 FROM workspace_members
			WHERE workspace_id = ${stub.workspace.id} AND user_id = ${second.userId}
		`;
			expect(stray).toHaveLength(0);
		},
	);
});
