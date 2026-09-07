import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { SQL } from "bun";
import { createAccount } from "../auth/accounts";
import { migrate } from "../db/app/migrate";
import type { AppDb } from "../db/app/pool";
import { createWorkspace } from "../workspaces/service";
import { dismiss, listDismissals, restore, restoreAll } from "./dismissals";

/**
 * Dismissal persistence against a real app database
 * (docs/spec/gripes.md "Dismissal").
 */

const ADMIN_URL = "postgres://datagripe:datagripe@localhost:5432/postgres";
const SCRATCH_DB = "datagripe_dismissals_test";

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
		"TRUNCATE gripe_dismissals, workspace_members, workspaces, users CASCADE",
	);
	userId = (await createAccount(appDb, "gripes@example.com", "hash")).userId;
	workspaceId = (await createWorkspace(appDb, userId, "Main")).id;
	otherWorkspaceId = (await createWorkspace(appDb, userId, "Other")).id;
});

afterAll(async () => {
	await appDb?.close();
});

async function clear(): Promise<void> {
	await appDb`DELETE FROM gripe_dismissals`;
}

describe("dismissals", () => {
	pgTest("a project dismissal round-trips with no key", async () => {
		await clear();
		const after = await dismiss(appDb, workspaceId, userId, {
			ruleId: "join.no-condition",
			scope: "project",
			key: null,
			idempotencyKey: "idem-key-0001",
		});
		expect(after).toEqual([
			{ ruleId: "join.no-condition", scope: "project", key: null },
		]);
	});

	pgTest("a target dismissal keeps its key", async () => {
		await clear();
		const after = await dismiss(appDb, workspaceId, userId, {
			ruleId: "join.no-condition",
			scope: "target",
			key: "doc-1",
			idempotencyKey: "idem-key-0002",
		});
		expect(after).toEqual([
			{ ruleId: "join.no-condition", scope: "target", key: "doc-1" },
		]);
	});

	pgTest(
		"dismissing the same thing twice is a no-op, not an error",
		async () => {
			await clear();
			const request = {
				ruleId: "join.no-condition",
				scope: "occurrence" as const,
				key: "deadbeef",
				idempotencyKey: "idem-key-0003",
			};
			await dismiss(appDb, workspaceId, userId, request);
			const after = await dismiss(appDb, workspaceId, userId, request);
			expect(after).toHaveLength(1);
		},
	);

	pgTest("the three scopes coexist for one rule", async () => {
		await clear();
		for (const [index, scope] of (
			["occurrence", "target", "project"] as const
		).entries()) {
			await dismiss(appDb, workspaceId, userId, {
				ruleId: "join.no-condition",
				scope,
				key: scope === "project" ? null : `key-${index}`,
				idempotencyKey: `idem-key-100${index}`,
			});
		}
		expect(await listDismissals(appDb, workspaceId)).toHaveLength(3);
	});

	pgTest("dismissals do not leak between workspaces", async () => {
		await clear();
		await dismiss(appDb, workspaceId, userId, {
			ruleId: "join.no-condition",
			scope: "project",
			key: null,
			idempotencyKey: "idem-key-0004",
		});
		expect(await listDismissals(appDb, otherWorkspaceId)).toEqual([]);
	});

	pgTest("restore removes exactly one dismissal", async () => {
		await clear();
		await dismiss(appDb, workspaceId, userId, {
			ruleId: "join.no-condition",
			scope: "target",
			key: "doc-1",
			idempotencyKey: "idem-key-0005",
		});
		await dismiss(appDb, workspaceId, userId, {
			ruleId: "join.no-condition",
			scope: "target",
			key: "doc-2",
			idempotencyKey: "idem-key-0006",
		});
		const after = await restore(appDb, workspaceId, userId, {
			ruleId: "join.no-condition",
			scope: "target",
			key: "doc-1",
		});
		expect(after).toEqual([
			{ ruleId: "join.no-condition", scope: "target", key: "doc-2" },
		]);
	});

	pgTest("restoring something not dismissed is harmless", async () => {
		await clear();
		const after = await restore(appDb, workspaceId, userId, {
			ruleId: "nope.rule",
			scope: "project",
			key: null,
		});
		expect(after).toEqual([]);
	});

	pgTest("restoreAll clears this workspace only", async () => {
		await clear();
		await dismiss(appDb, workspaceId, userId, {
			ruleId: "join.no-condition",
			scope: "project",
			key: null,
			idempotencyKey: "idem-key-0007",
		});
		await dismiss(appDb, otherWorkspaceId, userId, {
			ruleId: "join.no-condition",
			scope: "project",
			key: null,
			idempotencyKey: "idem-key-0008",
		});
		await restoreAll(appDb, workspaceId, userId);
		expect(await listDismissals(appDb, workspaceId)).toEqual([]);
		expect(await listDismissals(appDb, otherWorkspaceId)).toHaveLength(1);
	});

	pgTest("who dismissed it is recorded, for revisiting the scope", async () => {
		await clear();
		await dismiss(appDb, workspaceId, userId, {
			ruleId: "join.no-condition",
			scope: "project",
			key: null,
			idempotencyKey: "idem-key-0009",
		});
		const rows = await appDb<{ dismissed_by: string }[]>`
			SELECT dismissed_by FROM gripe_dismissals WHERE workspace_id = ${workspaceId}
		`;
		expect(rows[0]?.dismissed_by).toBe(userId);
	});

	pgTest("deleting a workspace takes its dismissals with it", async () => {
		await clear();
		const doomed = (await createWorkspace(appDb, userId, "Doomed")).id;
		await dismiss(appDb, doomed, userId, {
			ruleId: "join.no-condition",
			scope: "project",
			key: null,
			idempotencyKey: "idem-key-0010",
		});
		await appDb`DELETE FROM workspaces WHERE id = ${doomed}`;
		const rows = await appDb<{ n: string }[]>`
			SELECT count(*) AS n FROM gripe_dismissals WHERE workspace_id = ${doomed}
		`;
		expect(Number(rows[0]?.n)).toBe(0);
	});
});
