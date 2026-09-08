import { describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { runGit } from "./git";

/**
 * Committing the dump (docs/spec/domains.md "Committing").
 *
 * Against a real repository, because the two constraints worth having
 * are both about what git actually does: `add` must not stage the rest
 * of somebody's working tree, and a commit message must be an argv
 * element rather than a shell word.
 */

const OPTIONS = { timeoutMs: 20_000 };
const AUDIT = { workspaceId: "w-1", userId: "u-1" };

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

const available = await gitAvailable();
const gitTest = available ? test : test.skip;

async function run(cwd: string, args: string[]): Promise<void> {
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
	await child.exited;
}

/**
 * A repository with the export directory nested inside it and an
 * unrelated file already modified — the situation every real checkout is
 * in when somebody presses commit.
 */
async function repoWithPendingWork(): Promise<{
	repo: string;
	exportRoot: string;
}> {
	const repo = await mkdtemp(path.join(tmpdir(), "dg-git-"));
	await run(repo, ["init", "--initial-branch=main"]);
	await run(repo, ["config", "user.email", "test@example.com"]);
	await run(repo, ["config", "user.name", "Test"]);
	await writeFile(path.join(repo, "unrelated.txt"), "original\n");
	await run(repo, ["add", "."]);
	await run(repo, ["commit", "-m", "initial"]);

	// Somebody else's work in progress, which an export must never stage.
	await writeFile(path.join(repo, "unrelated.txt"), "mid-edit\n");

	const exportRoot = path.join(repo, "datasource", "schema");
	await mkdir(exportRoot, { recursive: true });
	await writeFile(path.join(exportRoot, "manifest.json"), "{}\n");
	return { repo, exportRoot };
}

async function stagedFiles(repo: string): Promise<string[]> {
	const child = Bun.spawn(["git", "diff", "--cached", "--name-only"], {
		cwd: repo,
		stdout: "pipe",
		stderr: "pipe",
	});
	const text = await new Response(child.stdout).text();
	await child.exited;
	return text.split("\n").filter((line) => line !== "");
}

describe("runGit", () => {
	gitTest("status reports only the domain root", async () => {
		const { exportRoot } = await repoWithPendingWork();
		const result = await runGit(
			exportRoot,
			"status",
			undefined,
			OPTIONS,
			AUDIT,
		);
		expect(result.exitCode).toBe(0);
		expect(result.branch).toBe("main");
		expect(result.changed.join("\n")).toContain("manifest.json");
		expect(result.changed.join("\n")).not.toContain("unrelated.txt");
	});

	gitTest("commit stages the domain root and nothing else", async () => {
		// The constraint most likely to be dropped during implementation,
		// and the one most likely to be noticed by ruining an afternoon.
		const { repo, exportRoot } = await repoWithPendingWork();
		const result = await runGit(
			exportRoot,
			"commit",
			"schema snapshot",
			OPTIONS,
			AUDIT,
		);
		expect(result.exitCode).toBe(0);
		expect(result.commitSha).toMatch(/^[0-9a-f]{40}$/);
		expect(await stagedFiles(repo)).toEqual([]);

		const log = Bun.spawn(["git", "show", "--stat", "--name-only", "HEAD"], {
			cwd: repo,
			stdout: "pipe",
			stderr: "pipe",
		});
		const shown = await new Response(log.stdout).text();
		await log.exited;
		expect(shown).toContain("manifest.json");
		expect(shown).not.toContain("unrelated.txt");
		// And the pending edit is still pending, unstaged and uncommitted.
		expect(await Bun.file(path.join(repo, "unrelated.txt")).text()).toBe(
			"mid-edit\n",
		);
	});

	gitTest("a message of --amend is a message, not a flag", async () => {
		const { repo, exportRoot } = await repoWithPendingWork();
		const before = Bun.spawn(["git", "rev-parse", "HEAD"], {
			cwd: repo,
			stdout: "pipe",
		});
		const firstSha = (await new Response(before.stdout).text()).trim();
		await before.exited;

		const result = await runGit(
			exportRoot,
			"commit",
			"--amend",
			OPTIONS,
			AUDIT,
		);
		expect(result.exitCode).toBe(0);
		// A new commit on top, not a rewritten one.
		expect(result.commitSha).not.toBe(firstSha);
		const log = Bun.spawn(["git", "log", "--format=%s", "-n", "2"], {
			cwd: repo,
			stdout: "pipe",
		});
		const subjects = (await new Response(log.stdout).text()).trim().split("\n");
		await log.exited;
		expect(subjects[0]).toBe("--amend");
		expect(subjects[1]).toBe("initial");
	});

	gitTest("a directory outside any work tree refuses", async () => {
		const loose = await mkdtemp(path.join(tmpdir(), "dg-norepo-"));
		await expect(
			runGit(loose, "status", undefined, OPTIONS, AUDIT),
		).rejects.toThrow(/not a git work tree/i);
	});

	gitTest(
		"a commit with no message refuses before running anything",
		async () => {
			const { exportRoot } = await repoWithPendingWork();
			await expect(
				runGit(exportRoot, "commit", "   ", OPTIONS, AUDIT),
			).rejects.toThrow(/needs a message/);
		},
	);

	gitTest("a push with no remote surfaces git's own stderr", async () => {
		// No credential management, as designed: the push fails, the exit
		// code is git's, and the message is git's.
		const { exportRoot } = await repoWithPendingWork();
		const result = await runGit(
			exportRoot,
			"commit-and-push",
			"schema snapshot",
			OPTIONS,
			AUDIT,
		);
		expect(result.exitCode).not.toBe(0);
		// Verbatim, not interpreted: this is git explaining itself.
		expect(result.stderr.toLowerCase()).toContain("push destination");
		// The commit still happened; only the push failed.
		expect(result.commitSha).toMatch(/^[0-9a-f]{40}$/);
	});
});
