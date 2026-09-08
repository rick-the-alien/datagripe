import path from "node:path";
import type { DomainGitOperation, DomainGitResult } from "@datagripe/contracts";
import { ErrorCodes } from "@datagripe/contracts/errors";
import { ServiceError } from "../connections/service";
import { log } from "../log";
import {
	currentBranch,
	type GitOptions,
	type RunResult,
	requireWorkTree,
	run,
} from "./run";

/**
 * Committing the domain dump (docs/spec/domains.md "Committing").
 *
 * Kept separate from `repo.ts` because it has a constraint the sidebar
 * does not: **`git add` is scoped to the domain root pathspec.** The
 * repository almost certainly has other work in progress, and an export
 * must never stage it. This is the constraint most likely to be dropped
 * during implementation and the one most likely to be noticed by
 * ruining somebody's afternoon.
 *
 * The sidebar's commit reaches the same guarantee by a different route —
 * it stages exactly the paths a person ticked — so the two paths stay
 * apart rather than being merged into one function with a flag.
 */

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
