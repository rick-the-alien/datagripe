import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import type { AccessObject } from "@datagripe/contracts";
import { SQL } from "bun";
import {
	type AccessReportData,
	AccessReportTooLargeError,
	readPostgresAccessReport,
	readPostgresRoles,
	rlsStateOf,
	toCell,
} from "./accessData";
import { readPostgresGrantStatements } from "./grantsData";

/**
 * The access report against a real PostgreSQL
 * (docs/spec/access-report.md).
 *
 * The headline test is `a grant to PUBLIC is invisible to the direct-grant
 * query`: it asserts both that this module sees the grant *and* that
 * `information_schema.role_table_grants` — which the object view's grants
 * tab uses — does not. That is the whole reason this file exists, and if
 * the naive query ever starts working the test should be deleted
 * deliberately rather than silently kept passing.
 */

const ADMIN_URL = "postgres://datagripe:datagripe@localhost:5432/postgres";
const SCRATCH_DB = "datagripe_access_test";
const LIMITS = { timeoutMs: 15_000, maxRows: 1000, estimateAboveRows: 1e9 };

async function probe(): Promise<boolean> {
	try {
		const sql = new SQL(ADMIN_URL, { connectionTimeout: 2 });
		const rows =
			await sql`SELECT rolsuper FROM pg_roles WHERE rolname = current_user`;
		await sql.close();
		return rows[0]?.rolsuper === true;
	} catch {
		return false;
	}
}

const reachable = await probe();
const pgTest = reachable ? test : test.skip;

let client: SQL;
let report: AccessReportData;

/**
 * PostgreSQL roles are **cluster-wide**, not per database, so these
 * outlive the scratch database and would show up in every other
 * project's role picker on a dev machine. `afterAll` drops them, and it
 * has to drop the database first: a role holding grants in a live
 * database cannot be dropped.
 */
const ROLES = ["dg_anon", "dg_authed", "dg_owner", "dg_authenticator"];

const FIXTURE = `
	CREATE SCHEMA api;
	CREATE SCHEMA hidden;

	-- Granted to PUBLIC and to nobody by name. The blind spot.
	CREATE TABLE api.public_table (id integer PRIMARY KEY, label text);
	GRANT SELECT ON api.public_table TO PUBLIC;

	-- Granted directly. The control.
	CREATE TABLE api.direct_table (id integer PRIMARY KEY);
	GRANT SELECT, INSERT ON api.direct_table TO dg_anon;

	-- Granted to a role dg_anon inherits. The second blind spot.
	CREATE TABLE api.inherited_table (id integer PRIMARY KEY);
	GRANT SELECT ON api.inherited_table TO dg_authed;

	-- RLS enabled, zero policies: denies everything, silently.
	CREATE TABLE api.locked (id integer PRIMARY KEY);
	ALTER TABLE api.locked ENABLE ROW LEVEL SECURITY;
	GRANT SELECT ON api.locked TO dg_anon;

	-- In a schema dg_anon has no USAGE on: the grant is inert.
	CREATE TABLE hidden.secrets (id integer PRIMARY KEY);
	GRANT SELECT ON hidden.secrets TO dg_anon;

	-- Default proacl: owner-all plus PUBLIC EXECUTE, which nobody chose.
	CREATE FUNCTION api.default_grants() RETURNS integer
		LANGUAGE sql AS $$ SELECT 1 $$;

	-- Same, but revoked. The counterexample.
	CREATE FUNCTION api.revoked() RETURNS integer
		LANGUAGE sql AS $$ SELECT 1 $$;
	REVOKE EXECUTE ON FUNCTION api.revoked() FROM PUBLIC;

	-- Security definer, reachable by anon: the escalation pair.
	CREATE FUNCTION api.definer() RETURNS integer
		LANGUAGE sql SECURITY DEFINER AS $$ SELECT 1 $$;

	-- Security definer with a pinned search_path. Not the same finding.
	CREATE FUNCTION api.pinned() RETURNS integer
		LANGUAGE sql SECURITY DEFINER SET search_path = api AS $$ SELECT 1 $$;

	CREATE VIEW api.v_secrets AS SELECT id FROM hidden.secrets;
	GRANT SELECT ON api.v_secrets TO dg_anon;

	GRANT USAGE ON SCHEMA api TO dg_anon, dg_authed;
	GRANT dg_authed TO dg_anon;
	GRANT dg_anon, dg_authed TO dg_authenticator;
`;

function objectNamed(name: string): AccessObject {
	const found = report.objects.find(
		(object) => object.name === name || object.name.startsWith(`${name}(`),
	);
	if (found === undefined) {
		throw new Error(`no object ${name} in report`);
	}
	return found;
}

function cellFor(name: string, role: string) {
	const found = objectNamed(name).cells.find((entry) => entry.role === role);
	if (found === undefined) {
		throw new Error(`no cell ${name}/${role}`);
	}
	return found;
}

beforeAll(async () => {
	if (!reachable) {
		return;
	}
	const admin = new SQL(ADMIN_URL);
	await admin.unsafe(`DROP DATABASE IF EXISTS ${SCRATCH_DB}`);
	await admin.unsafe(`CREATE DATABASE ${SCRATCH_DB}`);
	for (const role of ROLES) {
		await admin.unsafe(
			`DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = '${role}')
				THEN CREATE ROLE ${role} NOLOGIN; END IF; END $$`,
		);
	}
	await admin.close();

	client = new SQL(
		`postgres://datagripe:datagripe@localhost:5432/${SCRATCH_DB}`,
	);
	await client.unsafe(FIXTURE);
	report = await readPostgresAccessReport(client, LIMITS, {
		schemas: ["api", "hidden"],
		roles: ["dg_anon", "dg_authed"],
		domains: new Map(),
		only: [],
		maxCells: 250_000,
		countOnly: false,
	});
});

afterAll(async () => {
	await client?.close();
	if (!reachable) {
		return;
	}
	const admin = new SQL(ADMIN_URL);
	// The database first — it holds the grants that pin the roles.
	await admin.unsafe(`DROP DATABASE IF EXISTS ${SCRATCH_DB}`);
	for (const role of ROLES) {
		await admin.unsafe(`DROP ROLE IF EXISTS ${role}`).catch(() => {
			// A role someone else's session still references is not worth
			// failing a test run over; the next run reuses it.
		});
	}
	await admin.close();
});

describe("effective privileges", () => {
	pgTest(
		"a grant to PUBLIC is invisible to the direct-grant query",
		async () => {
			// This module sees it...
			const cell = cellFor("public_table", "dg_anon");
			expect(cell.privileges).toContain("select");
			expect(cell.sources).toContain("public");
			expect(cell.path).toBe("via PUBLIC");

			// ...and the query the object view's grants tab uses does not.
			// Scan `role_table_grants` for 'dg_anon' and you find nothing,
			// while dg_anon can read every row.
			const naive = await client`
			SELECT grantee FROM information_schema.role_table_grants
			WHERE table_schema = 'api' AND table_name = 'public_table'
				AND grantee = 'dg_anon'
		`;
			expect(naive).toHaveLength(0);
		},
	);

	pgTest("a directly granted privilege needs no marker", () => {
		const cell = cellFor("direct_table", "dg_anon");
		expect(cell.privileges.sort()).toEqual(["insert", "select"]);
		expect(cell.sources).toContain("direct");
	});

	pgTest("a privilege inherited through a role names the hop", () => {
		const cell = cellFor("inherited_table", "dg_anon");
		expect(cell.privileges).toContain("select");
		expect(cell.sources).toContain("role");
		expect(cell.path).toContain("via member of dg_authed");
	});

	pgTest("schema USAGE gates the cell", () => {
		// dg_anon holds SELECT on hidden.secrets and cannot enter `hidden`,
		// so the privilege is real and the access is not. Reporting it as
		// access is how a security report gets believed and is wrong.
		const cell = cellFor("secrets", "dg_anon");
		expect(cell.privileges).toContain("select");
		expect(cell.schemaBlocked).toBe(true);
	});

	pgTest("a NULL proacl means PUBLIC can execute", () => {
		// The default nobody chose. `proacl IS NULL` reads as "no grants" to
		// a naive ACL scan; it means owner-all plus PUBLIC EXECUTE.
		const cell = cellFor("default_grants", "dg_anon");
		expect(cell.privileges).toEqual(["execute"]);
		expect(cell.sources).toContain("public");
	});

	pgTest("REVOKE ... FROM PUBLIC empties the cell", () => {
		const cell = cellFor("revoked", "dg_anon");
		expect(cell.privileges).toEqual([]);
	});
});

describe("object facts", () => {
	pgTest("RLS enabled with zero policies is distinct from RLS off", () => {
		expect(objectNamed("locked").rls).toBe("on");
		expect(objectNamed("locked").policyCount).toBe(0);
		expect(objectNamed("direct_table").rls).toBe("off");
	});

	pgTest("a view reports its invoker setting, a table reports none", () => {
		expect(objectNamed("v_secrets").securityInvoker).toBe(false);
		expect(objectNamed("direct_table").securityInvoker).toBeNull();
	});

	pgTest("security definer and a pinned search_path are separate facts", () => {
		expect(objectNamed("definer").securityDefiner).toBe(true);
		expect(objectNamed("definer").searchPathPinned).toBe(false);
		expect(objectNamed("pinned").searchPathPinned).toBe(true);
	});

	pgTest("view dependencies name the base relation", () => {
		expect(report.viewDependencies.get("api.v_secrets")).toContain(
			"hidden.secrets",
		);
	});

	pgTest("routine overloads stay distinct by identity arguments", () => {
		expect(objectNamed("default_grants").name).toBe("default_grants()");
	});
});

describe("roles", () => {
	pgTest("memberships come back for the picker", async () => {
		const { roles } = await readPostgresRoles(client, LIMITS, null);
		const anon = roles.find((role) => role.name === "dg_anon");
		expect(anon?.memberOf).toContain("dg_authed");
	});

	pgTest(
		"an authenticator's reach is every role it can SET ROLE to",
		async () => {
			// 'MEMBER', not 'USAGE': SET ROLE works across a NOINHERIT
			// membership where privilege inheritance does not, so using USAGE
			// would under-report the set a request can arrive as.
			const { authenticatorReach } = await readPostgresRoles(
				client,
				LIMITS,
				"dg_authenticator",
			);
			expect(authenticatorReach).toContain("dg_anon");
			expect(authenticatorReach).toContain("dg_authed");
		},
	);
});

describe("bounds", () => {
	pgTest("countOnly returns a count and nothing else", async () => {
		const counted = await readPostgresAccessReport(client, LIMITS, {
			schemas: ["api"],
			roles: ["dg_anon"],
			domains: new Map(),
			only: [],
			maxCells: 250_000,
			countOnly: true,
		});
		expect(counted.cellCount).toBeGreaterThan(0);
		expect(counted.objects).toHaveLength(0);
	});

	pgTest(
		"over the cap refuses with the count, rather than truncating",
		async () => {
			await expect(
				readPostgresAccessReport(client, LIMITS, {
					schemas: ["api"],
					roles: ["dg_anon"],
					domains: new Map(),
					only: [],
					maxCells: 1,
					countOnly: false,
				}),
			).rejects.toBeInstanceOf(AccessReportTooLargeError);
		},
	);
});

describe("grant statements for the export", () => {
	pgTest("writes the implicit PUBLIC EXECUTE out explicitly", async () => {
		// Nobody typed this grant; PostgreSQL applied it. Emitting it is how
		// it becomes visible in a diff the day a function is added.
		const grants = await readPostgresGrantStatements(client, LIMITS, ["api"]);
		expect(grants.get("function:api.default_grants()")).toEqual([
			"-- Owner: datagripe",
			"GRANT EXECUTE ON FUNCTION api.default_grants() TO PUBLIC;",
		]);
	});

	pgTest("a revoked routine emits no PUBLIC line", async () => {
		const grants = await readPostgresGrantStatements(client, LIMITS, ["api"]);
		expect(grants.get("function:api.revoked()")).toEqual([
			"-- Owner: datagripe",
		]);
	});

	pgTest("relation grants are canonical and sorted", async () => {
		const grants = await readPostgresGrantStatements(client, LIMITS, ["api"]);
		// The owner's own ACL entry is excluded and stated as a comment
		// instead: emitting the owner's implicit full grant on every object
		// would bury the grants that are actually decisions.
		expect(grants.get("table:api.direct_table")).toEqual([
			"-- Owner: datagripe",
			"GRANT SELECT, INSERT ON TABLE api.direct_table TO dg_anon;",
		]);
	});
});

describe("toCell", () => {
	test("a purely direct cell has no path to explain", () => {
		expect(
			toCell({
				role: "r",
				privileges: ["select"],
				direct: ["select"],
				public: [],
				via_role: null,
				owner: false,
				superuser: false,
				schema_blocked: false,
			}).path,
		).toBeNull();
	});

	test("unknown privilege strings are dropped rather than passed through", () => {
		expect(
			toCell({ role: "r", privileges: ["select", "nonsense"] }).privileges,
		).toEqual(["select"]);
	});
});

describe("rlsStateOf", () => {
	test("a view has no RLS state at all", () => {
		expect(rlsStateOf({ relkind: "v" })).toBe("none");
	});

	test("forced is distinct from on", () => {
		expect(
			rlsStateOf({ relkind: "r", rls_enabled: true, rls_forced: true }),
		).toBe("forced");
		expect(
			rlsStateOf({ relkind: "r", rls_enabled: true, rls_forced: false }),
		).toBe("on");
	});
});
