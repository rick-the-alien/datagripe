import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { SQL } from "bun";
import { createAccount } from "../auth/accounts";
import { migrate } from "../db/app/migrate";
import type { AppDb } from "../db/app/pool";
import { createWorkspace } from "../workspaces/service";
import { exportPath, exportPaths, setExportPath } from "./runs";
import {
	clearImportedDomains,
	deleteDomain,
	listDomains,
	tag,
	upsertDomain,
} from "./service";

/**
 * Domain persistence against a real app database
 * (docs/spec/domains.md "Storage").
 *
 * The invariant worth testing directly rather than through the API: an
 * object has **at most one domain**, and that cannot be a database
 * constraint because the datasource identity lives on `domains` rather
 * than on `domain_tags`. So the test counts rows, not API responses.
 */

const ADMIN_URL = "postgres://datagripe:datagripe@localhost:5432/postgres";
const SCRATCH_DB = "datagripe_domains_test";
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
		"TRUNCATE domain_tags, domains, workspace_members, workspaces, users CASCADE",
	);
	userId = (await createAccount(appDb, "domains@example.com", "hash")).userId;
	workspaceId = (await createWorkspace(appDb, userId, "Main")).id;
	otherWorkspaceId = (await createWorkspace(appDb, userId, "Other")).id;
});

afterAll(async () => {
	await appDb?.close();
});

async function clear(): Promise<void> {
	await appDb`DELETE FROM domains`;
}

let keySeed = 0;
function key(): string {
	keySeed += 1;
	return `idem-key-${keySeed.toString().padStart(8, "0")}`;
}

async function makeDomain(
	name: string,
	options: {
		ref?: string;
		workspace?: string;
		includeData?: boolean;
		hidden?: boolean;
	} = {},
): Promise<string> {
	const result = await upsertDomain(appDb, options.workspace ?? workspaceId, {
		connectionRef: options.ref ?? REF,
		name,
		colour: 1,
		description: "",
		includeData: options.includeData ?? false,
		hidden: options.hidden ?? false,
		sortOrder: 0,
		idempotencyKey: key(),
	});
	return result.domain.id;
}

const USERS = { schema: "public", name: "users", kind: "table" as const };
const LOGIN = {
	schema: "public",
	name: "login(text, text)",
	kind: "function" as const,
};

describe("domains", () => {
	pgTest("a domain round-trips with its palette slot", async () => {
		await clear();
		const id = await makeDomain("auth");
		const { domains } = await listDomains(appDb, workspaceId, REF);
		expect(domains).toHaveLength(1);
		expect(domains[0]).toMatchObject({ id, name: "auth", colour: 1 });
	});

	pgTest("names are unique per datasource, not per workspace", async () => {
		await clear();
		await makeDomain("auth");
		await expect(makeDomain("auth")).rejects.toThrow(/already exists/);
		// The same name on a different datasource is a different opinion
		// about a different database.
		await expect(makeDomain("auth", { ref: OTHER_REF })).resolves.toBeTruthy();
	});

	pgTest("domains are scoped to one datasource in one workspace", async () => {
		await clear();
		await makeDomain("auth");
		await makeDomain("aggregation", { ref: OTHER_REF });
		await makeDomain("elsewhere", { workspace: otherWorkspaceId });
		const here = await listDomains(appDb, workspaceId, REF);
		expect(here.domains.map((domain) => domain.name)).toEqual(["auth"]);
	});

	pgTest("tagging assigns, and re-tagging moves", async () => {
		await clear();
		const auth = await makeDomain("auth");
		const source = await makeDomain("source");
		await tag(appDb, workspaceId, userId, {
			connectionRef: REF,
			targets: [USERS],
			domainId: auth,
			idempotencyKey: key(),
		});
		const after = await tag(appDb, workspaceId, userId, {
			connectionRef: REF,
			targets: [USERS],
			domainId: source,
			idempotencyKey: key(),
		});
		expect(after.tags).toHaveLength(1);
		expect(after.tags[0]?.domainId).toBe(source);
	});

	pgTest(
		"an object has at most one domain, counted in the database",
		async () => {
			// Asserted against the tables rather than the API response: the
			// constraint is enforced in the service, so the service could be
			// wrong in a way its own return value hides.
			await clear();
			const auth = await makeDomain("auth");
			const source = await makeDomain("source");
			for (const domainId of [auth, source, auth]) {
				await tag(appDb, workspaceId, userId, {
					connectionRef: REF,
					targets: [USERS],
					domainId,
					idempotencyKey: key(),
				});
			}
			const rows = await appDb<Array<{ count: string }>>`
			SELECT count(*)::text AS count
			FROM domain_tags t
			JOIN domains d ON d.id = t.domain_id
			WHERE d.workspace_id = ${workspaceId}
				AND d.connection_ref = ${REF}
				AND t.schema = 'public' AND t.name = 'users'
		`;
			expect(rows[0]?.count).toBe("1");
		},
	);

	pgTest("routine overloads tag independently", async () => {
		await clear();
		const auth = await makeDomain("auth");
		const other = {
			schema: "public",
			name: "login(integer)",
			kind: "function" as const,
		};
		const after = await tag(appDb, workspaceId, userId, {
			connectionRef: REF,
			targets: [LOGIN, other],
			domainId: auth,
			idempotencyKey: key(),
		});
		expect(after.tags).toHaveLength(2);
	});

	pgTest("a null domainId untags", async () => {
		await clear();
		const auth = await makeDomain("auth");
		await tag(appDb, workspaceId, userId, {
			connectionRef: REF,
			targets: [USERS, LOGIN],
			domainId: auth,
			idempotencyKey: key(),
		});
		const after = await tag(appDb, workspaceId, userId, {
			connectionRef: REF,
			targets: [USERS],
			domainId: null,
			idempotencyKey: key(),
		});
		expect(after.tags.map((entry) => entry.target.name)).toEqual([
			"login(text, text)",
		]);
	});

	pgTest("tagging into another workspace's domain is refused", async () => {
		await clear();
		const foreign = await makeDomain("auth", {
			workspace: otherWorkspaceId,
		});
		await expect(
			tag(appDb, workspaceId, userId, {
				connectionRef: REF,
				targets: [USERS],
				domainId: foreign,
				idempotencyKey: key(),
			}),
		).rejects.toThrow(/No such domain/);
	});

	pgTest("deleting a domain untags its objects and says how many", async () => {
		await clear();
		const auth = await makeDomain("auth");
		await tag(appDb, workspaceId, userId, {
			connectionRef: REF,
			targets: [USERS, LOGIN],
			domainId: auth,
			idempotencyKey: key(),
		});
		const result = await deleteDomain(appDb, workspaceId, {
			connectionRef: REF,
			id: auth,
		});
		expect(result.untagged).toBe(2);
		const { domains, tags } = await listDomains(appDb, workspaceId, REF);
		expect(domains).toHaveLength(0);
		expect(tags).toHaveLength(0);
	});

	pgTest("an update keeps the id and changes the rest", async () => {
		await clear();
		const id = await makeDomain("auth");
		const result = await upsertDomain(appDb, workspaceId, {
			connectionRef: REF,
			id,
			name: "authentication",
			colour: 5,
			description: "sessions and tokens",
			includeData: true,
			hidden: false,
			sortOrder: 3,
			idempotencyKey: key(),
		});
		expect(result.domain).toMatchObject({
			id,
			name: "authentication",
			colour: 5,
			includeData: true,
			sortOrder: 3,
		});
	});

	pgTest("the export path is per datasource, not per project", async () => {
		// The bug this replaced: one path per workspace meant two
		// datasources in one project overwrote each other's export tree,
		// silently, because both trees are structurally valid.
		await appDb`DELETE FROM datasource_export_paths`;
		await setExportPath(appDb, workspaceId, REF, "/tmp/prod-dump");
		await setExportPath(appDb, workspaceId, OTHER_REF, "/tmp/analytics-dump");
		expect(await exportPath(appDb, workspaceId, REF)).toBe("/tmp/prod-dump");
		expect(await exportPath(appDb, workspaceId, OTHER_REF)).toBe(
			"/tmp/analytics-dump",
		);
		// And it does not leak across projects either.
		expect(await exportPath(appDb, otherWorkspaceId, REF)).toBeNull();
	});

	pgTest("an empty path clears rather than storing a blank", async () => {
		await appDb`DELETE FROM datasource_export_paths`;
		await setExportPath(appDb, workspaceId, REF, "/tmp/dump");
		await setExportPath(appDb, workspaceId, REF, "   ");
		expect(await exportPath(appDb, workspaceId, REF)).toBeNull();
		expect((await exportPaths(appDb, workspaceId)).size).toBe(0);
	});

	pgTest("setting the path twice updates rather than conflicting", async () => {
		await appDb`DELETE FROM datasource_export_paths`;
		await setExportPath(appDb, workspaceId, REF, "/tmp/one");
		await setExportPath(appDb, workspaceId, REF, "/tmp/two");
		expect(await exportPath(appDb, workspaceId, REF)).toBe("/tmp/two");
	});

	pgTest("the name check rejects a directory-unsafe name", async () => {
		// The name becomes a directory in the export, so the database is the
		// last line of defence behind the Zod schema.
		await clear();
		// Wrapped in a function so the tagged template is actually executed:
		// a Bun SQL query is lazy, and handing the unawaited thenable to
		// `.rejects` leaves it holding a pooled connection forever.
		await expect(async () => {
			await appDb`
				INSERT INTO domains (workspace_id, connection_ref, name, colour)
				VALUES (${workspaceId}, ${REF}, ${"../etc"}, 1)
			`;
		}).toThrow();
	});
	pgTest("hidden round-trips and defaults to visible", async () => {
		// The shelf switch (docs/spec/domains.md "Hidden domains"). It says
		// nothing about tags: the same objects stay in the same domain.
		await clear();
		const shelfId = await makeDomain("inbuilt", { hidden: true });
		const plainId = await makeDomain("auth");
		const { domains } = await listDomains(appDb, workspaceId, REF);
		const shelf = domains.find((domain) => domain.id === shelfId);
		const plain = domains.find((domain) => domain.id === plainId);
		expect(shelf?.hidden).toBe(true);
		expect(plain?.hidden).toBe(false);
	});

	pgTest("a domain can be unhidden without losing its tags", async () => {
		await clear();
		const id = await makeDomain("inbuilt", { hidden: true });
		await tag(appDb, workspaceId, userId, {
			connectionRef: REF,
			targets: [{ schema: "public", name: "pg_stat_x", kind: "table" }],
			domainId: id,
			idempotencyKey: key(),
		});
		await upsertDomain(appDb, workspaceId, {
			connectionRef: REF,
			id,
			name: "inbuilt",
			colour: 1,
			description: "",
			includeData: false,
			hidden: false,
			sortOrder: 0,
			idempotencyKey: key(),
		});
		const { domains, tags } = await listDomains(appDb, workspaceId, REF);
		expect(domains[0]?.hidden).toBe(false);
		expect(tags).toHaveLength(1);
	});
	pgTest(
		"an import replaces the visible domains and keeps the shelves",
		async () => {
			// A shelf never reached the committed file, so the file has no
			// opinion about it (docs/spec/domains.md "Hidden domains"). Wiping
			// it because a teammate ran an export would lose local decisions
			// nobody asked to share.
			await clear();
			await makeDomain("auth");
			await makeDomain("inbuilt", { hidden: true });
			await clearImportedDomains(appDb, workspaceId, REF, ["auth", "billing"]);
			const { domains } = await listDomains(appDb, workspaceId, REF);
			expect(domains.map((domain) => domain.name)).toEqual(["inbuilt"]);
		},
	);

	pgTest("an incoming name takes a colliding shelf with it", async () => {
		// The unique index leaves no third option, and a failed import is
		// worse than an unhidden shelf.
		await clear();
		await makeDomain("inbuilt", { hidden: true });
		await clearImportedDomains(appDb, workspaceId, REF, ["inbuilt"]);
		const { domains } = await listDomains(appDb, workspaceId, REF);
		expect(domains).toEqual([]);
	});
});
