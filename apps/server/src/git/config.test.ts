import { describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import {
	readConfig,
	readSync,
	relativeToRepo,
	renderConfig,
	resolveRepoPath,
	writeSync,
} from "./config";

/**
 * `.datagripe/` (docs/spec/git-datasources.md "The `.datagripe`
 * directory").
 *
 * The theme of this file is that a committed configuration file is
 * **input from somewhere else**. It may have been written by a teammate,
 * or by whoever can open a pull request against the repository, so every
 * path in it is checked twice — lexically, and then against what the
 * filesystem actually resolves to.
 */

const VALID = `version: 1
datasource:
  name: wallet-prod
  adapter: postgres
  host: db.internal
  port: 5432
  database: wallet
  username: reader
  passwordEnv: WALLET_PG_PASSWORD
  tlsMode: verify-full
  readOnly: true
paths:
  - name: Some Folder
    path: foo
  - name: bar
    path: bar
`;

async function repoWith(config: string): Promise<string> {
	const root = await mkdtemp(path.join(tmpdir(), "dg-cfg-"));
	await mkdir(path.join(root, ".datagripe"), { recursive: true });
	await mkdir(path.join(root, "foo"), { recursive: true });
	await mkdir(path.join(root, "bar", "baz"), { recursive: true });
	await writeFile(path.join(root, ".datagripe", "config.yaml"), config);
	return root;
}

describe("readConfig", () => {
	test("reads the datasource, the branding and the paths", async () => {
		const root = await repoWith(VALID);
		const { config } = await readConfig(root);
		expect(config.datasource.name).toBe("wallet-prod");
		expect(config.datasource.passwordEnv).toBe("WALLET_PG_PASSWORD");
		expect(config.paths.map((entry) => entry.name)).toEqual([
			"Some Folder",
			"bar",
		]);
	});

	test("a repository without a config is not a datasource", async () => {
		const root = await mkdtemp(path.join(tmpdir(), "dg-cfg-"));
		// And it says which path it looked in: "not a datasource" on its own
		// sends people to the wrong directory.
		await expect(readConfig(root)).rejects.toThrow(/\.datagripe\/config\.yaml/);
	});

	test("an unknown version refuses the whole file", async () => {
		// Reading the parts it recognises would mean a half-understood
		// connection definition, which points at the wrong database.
		const root = await repoWith(VALID.replace("version: 1", "version: 9"));
		await expect(readConfig(root)).rejects.toThrow(/version 9/);
	});

	test("an inline password is refused, not deprecated", async () => {
		// connections.json can get away with "development only" because it
		// is gitignored. This file is the opposite of gitignored.
		const root = await repoWith(
			VALID.replace("  passwordEnv: WALLET_PG_PASSWORD", "  password: hunter2"),
		);
		await expect(readConfig(root)).rejects.toThrow(/inline 'password'/);
	});

	test("two paths with the same name are refused", async () => {
		const root = await repoWith(`${VALID}  - name: BAR\n    path: foo\n`);
		await expect(readConfig(root)).rejects.toThrow(/both called 'BAR'/i);
	});

	test("an absolute path in the config is refused by the schema", async () => {
		const root = await repoWith(
			VALID.replace("    path: foo", "    path: /etc"),
		);
		await expect(readConfig(root)).rejects.toThrow(/relative/);
	});

	test("a path that climbs out is refused by the schema", async () => {
		const root = await repoWith(
			VALID.replace("    path: foo", "    path: ../outside"),
		);
		await expect(readConfig(root)).rejects.toThrow(/climb/);
	});

	test("unknown top-level keys survive a write", async () => {
		// An older DataGripe must not silently delete a newer one's
		// settings, and a person's own notes block is theirs.
		const root = await repoWith(`${VALID}futureFeature:\n  enabled: true\n`);
		const { config, extra } = await readConfig(root);
		expect(extra).toEqual({ futureFeature: { enabled: true } });
		expect(renderConfig(config, extra)).toContain("futureFeature:");
	});
});

describe("resolveRepoPath", () => {
	test("`foo`, `./foo` and `foo/` are one directory", async () => {
		const root = await repoWith(VALID);
		const resolved = await Promise.all(
			["foo", "./foo", "foo/"].map((value) =>
				resolveRepoPath(root, value, "Path"),
			),
		);
		expect(new Set(resolved).size).toBe(1);
	});

	test("a nested path resolves", async () => {
		const root = await repoWith(VALID);
		expect(await resolveRepoPath(root, "bar/baz", "Path")).toEndWith(
			`bar${path.sep}baz`,
		);
	});

	test("a symlink out of the repository is refused, not followed", async () => {
		// The schema cannot catch this: `evil` is a perfectly ordinary
		// relative path right up until you ask the filesystem where it goes.
		const root = await repoWith(VALID);
		const outside = await mkdtemp(path.join(tmpdir(), "dg-outside-"));
		await symlink(outside, path.join(root, "evil"));
		await expect(resolveRepoPath(root, "evil", "Path")).rejects.toThrow(
			/outside the repository/,
		);
	});

	test("a directory that is not there says so", async () => {
		const root = await repoWith(VALID);
		await expect(resolveRepoPath(root, "nope", "Path")).rejects.toThrow(
			/does not exist/,
		);
	});
});

describe("sync.yaml", () => {
	test("absent is a normal state, not an error", async () => {
		const root = await repoWith(VALID);
		expect(await readSync(root)).toBeNull();
	});

	test("round-trips through a write", async () => {
		const root = await repoWith(VALID);
		await writeSync(root, {
			version: 1,
			sync: { dir: "domains", includeAccessReports: true },
		});
		expect((await readSync(root))?.sync.dir).toBe("domains");
	});

	test("relativeToRepo refuses a directory outside the checkout", () => {
		// `sync.dir` is committed: a relative path that resolves somewhere
		// else on a teammate's machine is worse than an error here.
		expect(() => relativeToRepo("/srv/repo", "/etc")).toThrow(/inside/);
	});

	test("relativeToRepo refuses the repository root itself", () => {
		// The dump prunes files it did not write; pointed at the root, it
		// would prune the repository.
		expect(() => relativeToRepo("/srv/repo", "/srv/repo")).toThrow(
			/repository root/,
		);
	});

	test("relativeToRepo returns POSIX-form for a directory inside", () => {
		expect(relativeToRepo("/srv/repo", "/srv/repo/db/schema")).toBe(
			"db/schema",
		);
	});
});
