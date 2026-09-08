import { describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type { Domain, DomainTarget } from "@datagripe/contracts";
import {
	buildExport,
	type ExportSource,
	objectFileBody,
	renderManifest,
	sqlLiteral,
} from "./exporter";
import { applyExport } from "./writer";

/**
 * The export tree (docs/spec/domains.md "Determinism is the
 * requirement").
 *
 * The property that matters: two runs over an unchanged database produce
 * identical bytes, so `git diff` is empty. An export that churns is an
 * export nobody commits.
 */

const AUTH: Domain = {
	id: "d-auth",
	name: "auth",
	colour: 1,
	description: "",
	includeData: false,
	sortOrder: 0,
};

const REFERENCE: Domain = {
	id: "d-ref",
	name: "reference",
	colour: 2,
	description: "static config",
	includeData: true,
	sortOrder: 1,
};

const USERS: DomainTarget = {
	schema: "basic_auth",
	name: "users",
	kind: "table",
};
const LOGIN: DomainTarget = {
	schema: "public",
	name: "login(text, text)",
	kind: "function",
};
const CASINOS: DomainTarget = {
	schema: "public",
	name: "casinos",
	kind: "table",
};

function source(overrides: Partial<ExportSource> = {}): ExportSource {
	return {
		connectionRef: "predefined:wallet-prod",
		connectionName: "wallet-prod",
		engine: "postgres",
		maxDataRows: 3,
		describe: async (target) => ({
			ddl: `CREATE TABLE ${target.schema}.${target.name} (id integer);`,
			primaryKey: ["id"],
			columns: ["id", "label"],
		}),
		grants: new Map([
			[
				"function:public.login(text, text)",
				["GRANT EXECUTE ON FUNCTION public.login(text, text) TO PUBLIC;"],
			],
		]),
		readData: async () => ({
			columns: ["id", "label"],
			rows: [
				[1, "one"],
				[2, null],
			],
			overflowed: false,
		}),
		accessFiles: new Map([["matrix.md", "# Permissions matrix\n"]]),
		untaggedCount: 4,
		...overrides,
	};
}

const TAGS = new Map<string, DomainTarget[]>([
	["d-auth", [LOGIN, USERS]],
	["d-ref", [CASINOS]],
]);

describe("buildExport", () => {
	test("lays objects out by domain and kind", async () => {
		const built = await buildExport([REFERENCE, AUTH], TAGS, source());
		expect([...built.files.keys()].sort()).toEqual([
			"access/matrix.md",
			"domains.yaml",
			"domains/auth/routines/public.login__text-text.sql",
			"domains/auth/tables/basic_auth.users.sql",
			"domains/reference/data/public.casinos.sql",
			"domains/reference/tables/public.casinos.sql",
		]);
		expect(built.domainCount).toBe(2);
		expect(built.objectCount).toBe(3);
		expect(built.untaggedCount).toBe(4);
	});

	test("is byte-identical across two runs", async () => {
		const first = await buildExport([AUTH, REFERENCE], TAGS, source());
		const second = await buildExport([REFERENCE, AUTH], TAGS, source());
		expect([...second.files.entries()].sort()).toEqual(
			[...first.files.entries()].sort(),
		);
	});

	test("no generated body carries a date, a size or a row count", async () => {
		const built = await buildExport([AUTH, REFERENCE], TAGS, source());
		const year = new Date().getFullYear().toString();
		for (const [name, contents] of built.files) {
			expect(contents, name).not.toContain(year);
			expect(contents, name).not.toMatch(/\bGenerated\b/i);
		}
	});

	test("every file ends in exactly one newline", async () => {
		const built = await buildExport([AUTH, REFERENCE], TAGS, source());
		for (const [name, contents] of built.files) {
			expect(contents.endsWith("\n"), name).toBe(true);
			expect(contents.endsWith("\n\n"), name).toBe(false);
		}
	});

	test("refuses data for a table with no primary key", async () => {
		// Unstable ordering would put a thousand-line diff in front of you
		// on every pull, so the table is refused rather than exported.
		const built = await buildExport(
			[REFERENCE],
			new Map([["d-ref", [CASINOS]]]),
			source({
				describe: async () => ({
					ddl: "CREATE TABLE public.casinos (label text);",
					primaryKey: [],
					columns: ["label"],
				}),
			}),
		);
		expect(built.refusals).toHaveLength(1);
		expect(built.refusals[0]?.reason).toContain("no primary key");
		// The DDL still landed: one refusal does not cost the whole object.
		expect(built.files.has("domains/reference/tables/public.casinos.sql")).toBe(
			true,
		);
		expect(built.files.has("domains/reference/data/public.casinos.sql")).toBe(
			false,
		);
	});

	test("refuses a table over the data-row cap rather than truncating", async () => {
		const built = await buildExport(
			[REFERENCE],
			new Map([["d-ref", [CASINOS]]]),
			source({
				readData: async () => ({
					columns: ["id"],
					rows: [[1], [2], [3]],
					overflowed: true,
				}),
			}),
		);
		expect(built.refusals[0]?.reason).toContain("row data cap".slice(4));
		expect(built.files.has("domains/reference/data/public.casinos.sql")).toBe(
			false,
		);
	});

	test("refuses an unsafe object name and keeps going", async () => {
		const built = await buildExport(
			[AUTH],
			new Map([
				[
					"d-auth",
					[
						{ schema: "../../etc", name: "passwd", kind: "table" },
						USERS,
					] as DomainTarget[],
				],
			]),
			source(),
		);
		expect(built.refusals).toHaveLength(1);
		expect(built.refusals[0]?.reason).toContain("Unsafe object name");
		expect(built.files.has("domains/auth/tables/basic_auth.users.sql")).toBe(
			true,
		);
	});

	test("a describe failure costs its own object and nothing else", async () => {
		let calls = 0;
		const built = await buildExport(
			[AUTH],
			new Map([["d-auth", [LOGIN, USERS]]]),
			source({
				describe: async (target) => {
					calls += 1;
					if (target.kind === "function") {
						throw new Error("routine vanished mid-export");
					}
					return {
						ddl: "CREATE TABLE x (id int);",
						primaryKey: [],
						columns: [],
					};
				},
			}),
		);
		expect(calls).toBe(2);
		expect(built.refusals[0]?.reason).toContain("vanished");
		expect(built.objectCount).toBe(1);
	});
});

describe("objectFileBody", () => {
	test("writes the implicit PUBLIC grant out explicitly", () => {
		// The whole point: `GRANT EXECUTE ... TO PUBLIC` appears even though
		// nobody typed it, so the default shows up in the diff.
		const body = objectFileBody(LOGIN, "CREATE FUNCTION public.login() ...", [
			"GRANT EXECUTE ON FUNCTION public.login(text, text) TO PUBLIC;",
		]);
		expect(body).toContain("TO PUBLIC;");
	});

	test("says so when there is nothing beyond the owner", () => {
		// Absence and silence are different: an empty grant block would read
		// as "not checked".
		expect(objectFileBody(USERS, "CREATE TABLE x (id int);", [])).toContain(
			"No grants beyond the owner",
		);
	});

	test("names the gap when the engine reported no definition", () => {
		expect(objectFileBody(USERS, null, [])).toContain(
			"did not report a definition",
		);
	});
});

describe("renderManifest", () => {
	test("writes fixed key order so the diff is the data changing", () => {
		const text = renderManifest({
			version: 1,
			connection: { ref: "r", name: "n", engine: "postgres" },
			domains: [],
		});
		// `version` first, where a reader looks for it, then the connection
		// in a fixed order. Alphabetical would put `engine` above `name`
		// and teach nobody anything.
		expect(text.split("\n").filter((line) => !line.startsWith("#"))).toEqual([
			"version: 1",
			"connection:",
			"  ref: r",
			"  name: n",
			"  engine: postgres",
			"domains: []",
			"",
		]);
	});

	test("a long description is never folded", () => {
		// Line folding is the trap: a description that grows by one
		// character would reflow a paragraph and put a twelve-line diff in
		// front of somebody who changed a word.
		const description = `${"word ".repeat(40)}end`;
		const text = renderManifest({
			version: 1,
			connection: { ref: "r", name: "n", engine: "postgres" },
			domains: [
				{
					name: "auth",
					colour: 1,
					description,
					includeData: false,
					objects: [],
				},
			],
		});
		expect(text).toContain(`end`);
		expect(
			text.split("\n").filter((line) => line.includes("word word")),
		).toHaveLength(1);
	});

	test("carries no host, port, user or password", async () => {
		const built = await buildExport([AUTH], TAGS, source());
		const manifest = built.files.get("domains.yaml") ?? "";
		for (const forbidden of ["host", "port", "password", "username"]) {
			expect(manifest.toLowerCase()).not.toContain(forbidden);
		}
	});
});

describe("sqlLiteral", () => {
	test("distinguishes null from the string 'null'", () => {
		expect(sqlLiteral(null)).toBe("NULL");
		expect(sqlLiteral("null")).toBe("'null'");
	});

	test("escapes quotes rather than concatenating SQL", () => {
		expect(sqlLiteral("O'Hara")).toBe("'O''Hara'");
	});

	test("renders booleans and numbers unquoted", () => {
		expect(sqlLiteral(true)).toBe("true");
		expect(sqlLiteral(42)).toBe("42");
	});
});

describe("applyExport", () => {
	async function root(): Promise<string> {
		return mkdtemp(path.join(tmpdir(), "dg-export-"));
	}

	test("a dry run writes nothing", async () => {
		const dir = await root();
		const built = await buildExport([AUTH], TAGS, source());
		const plan = await applyExport(dir, built, { dryRun: true });
		expect(plan.written).toBeGreaterThan(0);
		expect(plan.dryRun).toBe(true);
		expect(await readdir(dir)).toEqual([]);
	});

	test("a second apply reports everything unchanged", async () => {
		const dir = await root();
		const built = await buildExport([AUTH], TAGS, source());
		await applyExport(dir, built, { dryRun: false });
		const again = await applyExport(dir, built, { dryRun: false });
		expect(again.written).toBe(0);
		expect(again.deleted).toBe(0);
		expect(again.unchanged).toBe(built.files.size);
	});

	test("untagging an object prunes its file", async () => {
		const dir = await root();
		await applyExport(dir, await buildExport([AUTH], TAGS, source()), {
			dryRun: false,
		});
		const stale = path.join(dir, "domains/auth/tables/basic_auth.users.sql");
		expect(await Bun.file(stale).exists()).toBe(true);

		const pruned = await applyExport(
			dir,
			await buildExport([AUTH], new Map([["d-auth", [LOGIN]]]), source()),
			{ dryRun: false },
		);
		expect(pruned.deleted).toBe(1);
		expect(await Bun.file(stale).exists()).toBe(false);
	});

	test("the prune never leaves the directories the export owns", async () => {
		const dir = await root();
		await mkdir(path.join(dir, "migrations"), { recursive: true });
		await writeFile(path.join(dir, "migrations", "0001.sql"), "-- mine\n");
		await writeFile(path.join(dir, "README.md"), "# mine\n");
		await applyExport(dir, await buildExport([AUTH], TAGS, source()), {
			dryRun: false,
		});
		expect(await Bun.file(path.join(dir, "README.md")).text()).toBe("# mine\n");
		expect(await Bun.file(path.join(dir, "migrations/0001.sql")).text()).toBe(
			"-- mine\n",
		);
	});

	test("pull.log survives the prune", async () => {
		// The one file allowed to be nondeterministic, and the one the
		// prune must never take.
		const dir = await root();
		await writeFile(path.join(dir, "pull.log"), "earlier run\n");
		await applyExport(dir, await buildExport([AUTH], TAGS, source()), {
			dryRun: false,
		});
		expect(await Bun.file(path.join(dir, "pull.log")).text()).toContain(
			"earlier run",
		);
	});

	test("a dry run describes the same deletions the apply performs", async () => {
		const dir = await root();
		await applyExport(dir, await buildExport([AUTH], TAGS, source()), {
			dryRun: false,
		});
		const shrunk = await buildExport(
			[AUTH],
			new Map([["d-auth", [LOGIN]]]),
			source(),
		);
		const preview = await applyExport(dir, shrunk, { dryRun: true });
		const applied = await applyExport(dir, shrunk, { dryRun: false });
		expect(preview.entries.filter((e) => e.action === "deleted")).toEqual(
			applied.entries.filter((e) => e.action === "deleted"),
		);
	});
});
