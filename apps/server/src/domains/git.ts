import path from "node:path";
import type { DomainGitOperation, DomainGitResult } from "@datagripe/contracts";
import { ErrorCodes } from "@datagripe/contracts/errors";
import { ServiceError } from "../connections/service";
import { log } from "../log";
import { isWithin } from "./paths";

/**
 * Committing the dump (docs/spec/domains.md "Committing").
 *
 * There is no credential management here and none is planned. DataGripe
 * runs `git` the way you would, with your ambient configuration, and if
 * the push has no credentials the push fails and you get git's own
 * stderr, verbatim. That is the correct amount of opinion for this
 * feature to have.
 *
 * What it *is* opinionated about:
 *
 * - **argv, never a shell.** `Bun.spawn` with an argument array and no
 *   shell interpretation, so a commit message of `--amend` is a message.
 * - **A fixed verb list.** No user-supplied flag reaches any invocation.
 * - **`git add` is scoped to the domain-root pathspec.** The repository
 *   almost certainly has other work in progress, and an export must
 *   never stage it. This is the constraint most likely to be dropped
 *   during implementation and the one most likely to be noticed by
 *   ruining somebody's afternoon.
 * - **A credential prompt is an error, not a hang.**
 */

export interface GitOptions {
	timeoutMs: number;
}

interface RunResult {
	exitCode: number;
	stdout: string;
	stderr: string;
}

/**
 * `HOME`, `PATH` and `SSH_AUTH_SOCK` pass through, because that is where
 * working credentials live. Everything about prompting is disabled, so a
 * missing credential fails immediately instead of blocking until the
 * timeout with a process nobody can see.
 */
function gitEnvironment(): Record<string, string> {
	const inherited: Record<string, string> = {};
	for (const key of ["HOME", "PATH", "SSH_AUTH_SOCK", "LANG", "USER"]) {
		const value = process.env[key];
		if (value !== undefined) {
			inherited[key] = value;
		}
	}
	return {
		...inherited,
		GIT_TERMINAL_PROMPT: "0",
		GIT_ASKPASS: "/bin/false",
		SSH_ASKPASS: "/bin/false",
		SSH_ASKPASS_REQUIRE: "never",
		GIT_PAGER: "cat",
	};
}

async function run(
	cwd: string,
	args: string[],
	options: GitOptions,
): Promise<RunResult> {
	const child = Bun.spawn(["git", ...args], {
		cwd,
		env: gitEnvironment(),
		stdout: "pipe",
		stderr: "pipe",
		stdin: "ignore",
	});
	const timer = setTimeout(() => {
		child.kill();
	}, options.timeoutMs);
	try {
		const [stdout, stderr, exitCode] = await Promise.all([
			new Response(child.stdout).text(),
			new Response(child.stderr).text(),
			child.exited,
		]);
		return { exitCode, stdout, stderr };
	} finally {
		clearTimeout(timer);
	}
}

/**
 * The domain root must live inside the work tree git reports. A root
 * that is not in a repository, or one whose repository does not contain
 * it, refuses and runs nothing else.
 */
async function requireWorkTree(
	root: string,
	options: GitOptions,
): Promise<string> {
	const result = await run(root, ["rev-parse", "--show-toplevel"], options);
	const top = result.stdout.trim();
	if (result.exitCode !== 0 || top === "") {
		throw new ServiceError(
			ErrorCodes.BadRequest,
			`Not a git work tree: ${root}${result.stderr.trim() === "" ? "" : ` — ${result.stderr.trim()}`}`,
		);
	}
	if (!isWithin(top, root)) {
		throw new ServiceError(
			ErrorCodes.BadRequest,
			`Export directory is not inside its git work tree (${top})`,
		);
	}
	return top;
}

async function currentBranch(
	root: string,
	options: GitOptions,
): Promise<string | null> {
	const result = await run(
		root,
		["rev-parse", "--abbrev-ref", "HEAD"],
		options,
	);
	const branch = result.stdout.trim();
	return result.exitCode === 0 && branch !== "" ? branch : null;
}

/** Porcelain lines, scoped to the domain root and nothing else. */
async function status(
	root: string,
	options: GitOptions,
): Promise<{ result: RunResult; changed: string[] }> {
	// `-uall` because the default collapses an untracked directory to one
	// line (`?? datasource/schema/`), and the tab needs the files.
	const result = await run(
		root,
		["status", "--porcelain", "-uall", "--", root],
		options,
	);
	const changed = result.stdout
		.split("\n")
		.map((line) => line.trimEnd())
		.filter((line) => line !== "");
	return { result, changed };
}

export async function runGit(
	root: string,
	operation: DomainGitOperation,
	message: string | undefined,
	options: GitOptions,
	audit: { workspaceId: string; userId: string },
): Promise<DomainGitResult> {
	await requireWorkTree(root, options);
	const branch = await currentBranch(root, options);
	log.audit("domain.git", {
		...audit,
		operation,
		root,
		branch,
	});

	if (operation === "status") {
		const { result, changed } = await status(root, options);
		return {
			operation,
			exitCode: result.exitCode,
			stdout: result.stdout,
			stderr: result.stderr,
			branch,
			changed,
			commitSha: null,
		};
	}

	if (message === undefined || message.trim() === "") {
		throw new ServiceError(ErrorCodes.BadRequest, "A commit needs a message");
	}

	const transcript: string[] = [];
	const errors: string[] = [];
	let exitCode = 0;

	// Scoped to the domain root. Anything else in the working tree stays
	// unstaged, which is the whole point.
	const added = await run(root, ["add", "--", root], options);
	transcript.push(added.stdout);
	errors.push(added.stderr);
	if (added.exitCode !== 0) {
		return {
			operation,
			exitCode: added.exitCode,
			stdout: transcript.join(""),
			stderr: errors.join(""),
			branch,
			changed: [],
			commitSha: null,
		};
	}

	// `--` terminates the options so the message can never be read as one.
	const committed = await run(root, ["commit", "-m", message, "--"], options);
	transcript.push(committed.stdout);
	errors.push(committed.stderr);
	exitCode = committed.exitCode;

	let commitSha: string | null = null;
	if (committed.exitCode === 0) {
		const head = await run(root, ["rev-parse", "HEAD"], options);
		const sha = head.stdout.trim();
		commitSha = sha === "" ? null : sha;
	}

	if (operation === "commit-and-push" && committed.exitCode === 0) {
		const pushed = await run(root, ["push"], options);
		transcript.push(pushed.stdout);
		errors.push(pushed.stderr);
		// Git's verdict, not ours. A push that failed for want of
		// credentials reports exactly what git said about it.
		exitCode = pushed.exitCode;
	}

	const { changed } = await status(root, options);
	return {
		operation,
		exitCode,
		stdout: transcript.join(""),
		stderr: errors.join(""),
		branch,
		changed,
		commitSha,
	};
}

/** Exposed for tests: the pathspec an `add` is limited to. */
export function addPathspec(root: string): string[] {
	return ["add", "--", path.resolve(root)];
}
