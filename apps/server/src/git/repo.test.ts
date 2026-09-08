import { describe, expect, test } from "bun:test";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { commit, incomingPaths, pull, push, stage, status } from "./repo";
import { parseStatus, unquotePath } from "./run";

/**
 * The repository section's operations (docs/spec/git-datasources.md
 * "The repository section").
 *
 * Against a real repository, because every constraint worth having here
 * is about what git actually does. The one this file exists for:
 * **a commit stages exactly what was ticked.** The domain export gets
 * that guarantee from a root-scoped pathspec; the sidebar gets it from
 * the checkbox list, and if that ever slips it slips silently and takes
 * somebody's work-in-progress into a commit with it.
 */

const OPTIONS = { timeoutMs: 20_000 };
const AUDIT = { workspaceId: "w-1", userId: "u-1", connectionRef: "git:x" };

async function gitAvailable(): Promise<boolean> {
	try {
		const child = Bun.spawn(["git", "--version"], {
			stdout: "pipe",
			stderr: "pipe",
		});
		return (await child.exited) === 0;
	} catch {
		return false;
	}
}

const gitTest = (await gitAvailable()) ? test : test.skip;

async function git(cwd: string, args: string[]): Promise<string> {
	const child = Bun.spawn(["git", ...args], {
		cwd,
		stdout: "pipe",
		stderr: "pipe",
		env: {
			...process.env,
			GIT_AUTHOR_NAME: "Test",
			GIT_AUTHOR_EMAIL: "test@example.com",
			GIT_COMMITTER_NAME: "Test",
			GIT_COMMITTER_EMAIL: "test@example.com",
		},
	});
	const out = await new Response(child.stdout).text();
	await child.exited;
	return out;
}

/** A repository with five modified files, which is the interesting case. */
async function repoWithChanges(): Promise<string> {
	const root = await mkdtemp(path.join(tmpdir(), "dg-repo-"));
	await git(root, ["init", "--initial-branch=main"]);
	await git(root, ["config", "user.email", "test@example.com"]);
	await git(root, ["config", "user.name", "Test"]);
	for (const name of ["a.sql", "b.sql", "c.sql", "d.sql", "e.sql"]) {
		await writeFile(path.join(root, name), "select 1;\n");
	}
	await git(root, ["add", "."]);
	await git(root, ["commit", "-m", "initial"]);
	for (const name of ["a.sql", "b.sql", "c.sql", "d.sql", "e.sql"]) {
		await writeFile(path.join(root, name), `select 2; -- ${name}\n`);
	}
	return root;
}

describe("status", () => {
	gitTest("reports the whole work tree, not a sub-path", async () => {
		const root = await repoWithChanges();
		const result = await status(root, OPTIONS);
		expect(result.branch).toBe("main");
		expect(result.entries).toHaveLength(5);
		// Hiding a changed file because it sits outside a configured path
		// is how you commit half of something.
		expect(result.entries.map((entry) => entry.path).sort()).toEqual([
			"a.sql",
			"b.sql",
			"c.sql",
			"d.sql",
			"e.sql",
		]);
		expect(result.truncated).toBe(false);
	});

	gitTest("has no upstream in a fresh repository", async () => {
		const result = await status(await repoWithChanges(), OPTIONS);
		expect(result.upstream).toBeNull();
		expect(result.ahead).toBe(0);
		expect(result.behind).toBe(0);
	});
});

describe("commit", () => {
	gitTest("stages exactly the ticked paths and nothing else", async () => {
		const root = await repoWithChanges();
		const result = await commit(
			root,
			"two of five",
			["a.sql", "c.sql"],
			OPTIONS,
			AUDIT,
		);
		expect(result.exitCode).toBe(0);

		const committed = (
			await git(root, ["show", "--name-only", "--format=", "HEAD"])
		)
			.split("\n")
			.filter((line) => line !== "");
		expect(committed.sort()).toEqual(["a.sql", "c.sql"]);

		// And the other three are still modified, unstaged, uncommitted.
		expect(result.status.entries.map((entry) => entry.path).sort()).toEqual([
			"b.sql",
			"d.sql",
			"e.sql",
		]);
	});

	gitTest("a message of --amend is a message, not a flag", async () => {
		const root = await repoWithChanges();
		const first = (await git(root, ["rev-parse", "HEAD"])).trim();
		const result = await commit(root, "--amend", ["a.sql"], OPTIONS, AUDIT);
		expect(result.exitCode).toBe(0);
		// A new commit on top, not a rewritten one.
		expect(result.commitSha).not.toBe(first);
		expect((await git(root, ["log", "--format=%s", "-n", "1"])).trim()).toBe(
			"--amend",
		);
	});

	gitTest("a filename beginning with a dash is a filename", async () => {
		const root = await repoWithChanges();
		await writeFile(path.join(root, "-weird.sql"), "select 3;\n");
		const result = await commit(root, "dashed", ["-weird.sql"], OPTIONS, AUDIT);
		expect(result.exitCode).toBe(0);
		expect(
			await git(root, ["show", "--name-only", "--format=", "HEAD"]),
		).toContain("-weird.sql");
	});

	gitTest("an empty message refuses before running anything", async () => {
		const root = await repoWithChanges();
		await expect(commit(root, "   ", [], OPTIONS, AUDIT)).rejects.toThrow(
			/needs a message/,
		);
		// Nothing was staged on the way to the refusal.
		expect(await git(root, ["diff", "--cached", "--name-only"])).toBe("");
	});
});

describe("stage", () => {
	gitTest("ticking stages and unticking unstages", async () => {
		const root = await repoWithChanges();
		const staged = await stage(root, ["b.sql"], true, OPTIONS, AUDIT);
		expect(staged.entries.find((entry) => entry.path === "b.sql")?.staged).toBe(
			true,
		);

		const unstaged = await stage(root, ["b.sql"], false, OPTIONS, AUDIT);
		expect(
			unstaged.entries.find((entry) => entry.path === "b.sql")?.staged,
		).toBe(false);
	});
});

describe("push and pull", () => {
	gitTest("a push with no remote surfaces git's own stderr", async () => {
		// No credential management, as designed: the exit code is git's and
		// the message is git's, verbatim.
		const root = await repoWithChanges();
		const result = await push(root, false, OPTIONS, AUDIT);
		expect(result.exitCode).not.toBe(0);
		expect(result.stderr.toLowerCase()).toContain("push destination");
	});

	gitTest("a pull with no upstream fails rather than hanging", async () => {
		const root = await repoWithChanges();
		const result = await pull(root, OPTIONS, AUDIT);
		expect(result.exitCode).not.toBe(0);
		expect(result.headMoved).toBe(false);
	});

	gitTest(
		"incomingPaths is empty with no upstream, and fetches nothing",
		async () => {
			expect(await incomingPaths(await repoWithChanges(), OPTIONS)).toEqual([]);
		},
	);
});

describe("parseStatus", () => {
	test("keeps git's letters and tells staged from not", () => {
		const entries = parseStatus(
			[
				"M  staged.sql",
				" M unstaged.sql",
				"?? new.sql",
				"MM both.sql",
				"R  old.sql -> new-name.sql",
			].join("\n"),
		);
		expect(entries.map((entry) => entry.status)).toEqual([
			"M ",
			" M",
			"??",
			"MM",
			"R ",
		]);
		expect(entries.map((entry) => entry.staged)).toEqual([
			true,
			false,
			false,
			true,
			true,
		]);
		// A rename's path is the destination; where it came from is kept.
		expect(entries[4]?.path).toBe("new-name.sql");
		expect(entries[4]?.originalPath).toBe("old.sql");
	});
});

describe("unquotePath", () => {
	test("decodes git's C-style quoting", () => {
		// The tree needs the real bytes, not `"caf\303\251.sql"`.
		expect(unquotePath('"caf\\303\\251.sql"')).toBe("café.sql");
		expect(unquotePath('"with space.sql"')).toBe("with space.sql");
		expect(unquotePath('"say \\"hi\\".sql"')).toBe('say "hi".sql');
		expect(unquotePath("plain.sql")).toBe("plain.sql");
	});
});
