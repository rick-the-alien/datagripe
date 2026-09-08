import type { GitStatusEntry, GitStatusResult } from "@datagripe/contracts";
import { GIT_STATUS_MAX_ENTRIES } from "@datagripe/contracts";
import { ErrorCodes } from "@datagripe/contracts/errors";
import { ServiceError } from "../connections/service";
import { isWithin } from "../domains/paths";

/**
 * Running the system `git` (docs/spec/git-datasources.md, and
 * docs/spec/domains.md "Committing", which set these rules first).
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
 * - **A fixed verb list.** No user-supplied flag reaches any
 *   invocation; every user-supplied value follows a `--`.
 * - **A credential prompt is an error, not a hang.**
 * - **Every invocation is a press.** Nothing in this module is called on
 *   a timer, on open, or on save.
 */

export interface GitOptions {
	timeoutMs: number;
}

export interface RunResult {
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
export function gitEnvironment(): Record<string, string> {
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

export async function run(
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
	let timedOut = false;
	const timer = setTimeout(() => {
		timedOut = true;
		child.kill();
	}, options.timeoutMs);
	try {
		const [stdout, stderr, exitCode] = await Promise.all([
			new Response(child.stdout).text(),
			new Response(child.stderr).text(),
			child.exited,
		]);
		return {
			exitCode,
			stdout,
			// A killed process explains itself, because git did not get to.
			stderr: timedOut
				? `${stderr}\ngit timed out after ${options.timeoutMs}ms and was killed`
				: stderr,
		};
	} finally {
		clearTimeout(timer);
	}
}

/**
 * The work tree root git reports for a directory. A directory that is
 * not in a repository refuses and runs nothing else.
 */
export async function workTreeRoot(
	directory: string,
	options: GitOptions,
): Promise<string> {
	const result = await run(
		directory,
		["rev-parse", "--show-toplevel"],
		options,
	);
	const top = result.stdout.trim();
	if (result.exitCode !== 0 || top === "") {
		throw new ServiceError(
			ErrorCodes.BadRequest,
			`Not a git work tree: ${directory}${result.stderr.trim() === "" ? "" : ` — ${result.stderr.trim()}`}`,
		);
	}
	return top;
}

/**
 * As above, and additionally that the directory is *inside* the tree git
 * reported. Used by the domain export, whose root must live in the work
 * tree it is about to commit to.
 */
export async function requireWorkTree(
	root: string,
	options: GitOptions,
): Promise<string> {
	const top = await workTreeRoot(root, options);
	if (!isWithin(top, root)) {
		throw new ServiceError(
			ErrorCodes.BadRequest,
			`Export directory is not inside its git work tree (${top})`,
		);
	}
	return top;
}

export async function currentBranch(
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

export async function headSha(
	root: string,
	options: GitOptions,
): Promise<string | null> {
	const result = await run(root, ["rev-parse", "HEAD"], options);
	const sha = result.stdout.trim();
	return result.exitCode === 0 && sha !== "" ? sha : null;
}

/**
 * Unquote a porcelain path. git quotes a path containing anything
 * unusual as a C string; the file tree needs the real bytes, not
 * `"caf\303\251.sql"`.
 */
export function unquotePath(value: string): string {
	if (!value.startsWith('"') || !value.endsWith('"')) {
		return value;
	}
	const body = value.slice(1, -1);
	const bytes: number[] = [];
	for (let index = 0; index < body.length; index += 1) {
		if (body[index] !== "\\") {
			bytes.push(body.charCodeAt(index));
			continue;
		}
		const next = body[index + 1];
		index += 1;
		switch (next) {
			case "n":
				bytes.push(10);
				break;
			case "t":
				bytes.push(9);
				break;
			case "r":
				bytes.push(13);
				break;
			case '"':
			case "\\":
				bytes.push(next.charCodeAt(0));
				break;
			default: {
				// Three octal digits: git's escape for a non-ASCII byte.
				const octal = body.slice(index, index + 3);
				if (/^[0-7]{3}$/.test(octal)) {
					bytes.push(Number.parseInt(octal, 8));
					index += 2;
				} else if (next !== undefined) {
					bytes.push(next.charCodeAt(0));
				}
			}
		}
	}
	return new TextDecoder().decode(Uint8Array.from(bytes));
}

/**
 * Parse `git status --porcelain -uall` into rows.
 *
 * The status letters are kept as git wrote them and are never
 * paraphrased: people who use git read `??` and ` M` already, and people
 * who do not are not served by an invented word.
 */
export function parseStatus(stdout: string): GitStatusEntry[] {
	const entries: GitStatusEntry[] = [];
	for (const line of stdout.split("\n")) {
		if (line.length < 4) {
			continue;
		}
		const status = line.slice(0, 2);
		const rest = line.slice(3);
		// A rename is `R  old -> new`; the destination is the path.
		const arrow = rest.indexOf(" -> ");
		const rawPath = arrow === -1 ? rest : rest.slice(arrow + 4);
		const rawOriginal = arrow === -1 ? null : rest.slice(0, arrow);
		entries.push({
			status,
			path: unquotePath(rawPath),
			originalPath: rawOriginal === null ? null : unquotePath(rawOriginal),
			// Column one is the index: anything but a space or `?` is staged.
			staged: status[0] !== " " && status[0] !== "?",
		});
	}
	return entries;
}

/** `ahead` / `behind` against the upstream, when there is one. */
async function tracking(
	root: string,
	options: GitOptions,
): Promise<{ upstream: string | null; ahead: number; behind: number }> {
	const name = await run(
		root,
		["rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{upstream}"],
		options,
	);
	const upstream = name.stdout.trim();
	if (name.exitCode !== 0 || upstream === "") {
		return { upstream: null, ahead: 0, behind: 0 };
	}
	// `--count` gives "<behind>\t<ahead>" for `upstream...HEAD`; using
	// the three-dot form means no fetch is implied.
	const counts = await run(
		root,
		["rev-list", "--left-right", "--count", `${upstream}...HEAD`],
		options,
	);
	const [behind, ahead] = counts.stdout
		.trim()
		.split(/\s+/)
		.map((value) => Number.parseInt(value, 10));
	return {
		upstream,
		ahead: Number.isFinite(ahead) ? (ahead as number) : 0,
		behind: Number.isFinite(behind) ? (behind as number) : 0,
	};
}

/**
 * The whole work tree's status, not a sub-path.
 *
 * This is a repository view: hiding a changed file because it is outside
 * a configured datasource path is how you commit half of something.
 */
export async function repoStatus(
	root: string,
	options: GitOptions,
): Promise<GitStatusResult> {
	// `-uall` because the default collapses an untracked directory to one
	// line (`?? bar/`), and the section needs the files.
	const result = await run(root, ["status", "--porcelain", "-uall"], options);
	if (result.exitCode !== 0) {
		throw new ServiceError(
			ErrorCodes.BadRequest,
			`git status failed: ${result.stderr.trim()}`,
		);
	}
	const all = parseStatus(result.stdout);
	const { upstream, ahead, behind } = await tracking(root, options);
	return {
		repoPath: root,
		branch: await currentBranch(root, options),
		upstream,
		ahead,
		behind,
		entries: all.slice(0, GIT_STATUS_MAX_ENTRIES),
		total: all.length,
		truncated: all.length > GIT_STATUS_MAX_ENTRIES,
	};
}
