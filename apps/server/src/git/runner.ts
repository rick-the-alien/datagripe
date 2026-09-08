import path from "node:path";
import type { RepoCommand } from "@datagripe/contracts";
import { ErrorCodes } from "@datagripe/contracts/errors";
import { ServiceError } from "../connections/service";
import { log } from "../log";
import { resolveRepoPath } from "./config";

/**
 * Running a command a repository declared
 * (docs/spec/repo-commands.md "Running one").
 *
 * The trust check happens before anything reaches this module; what is
 * left is the execution itself, and it keeps the rules the git runner
 * set:
 *
 * - **argv, never a shell.** `Bun.spawn` with the array from the file,
 *   no shell interpretation, no interpolation. There is nothing to
 *   quote and nothing to inject into.
 * - **A minimal environment.** `PATH`, `HOME` and the terminal basics,
 *   plus whatever the command declared. The server's own environment is
 *   not handed over — `CONNECTION_ENCRYPTION_KEY` and `SESSION_SECRET`
 *   live there, and a command from a repository has no business seeing
 *   them.
 * - **A timeout, and a kill that reaches the children.** The whole
 *   point of the feature is starting a database, so a process that
 *   spawns others is the normal case rather than the exception.
 * - **Output is streamed verbatim**, in arrival order, and the exit code
 *   is the verdict.
 */

export interface RunHandle {
	runId: string;
	argv: string[];
	cwd: string;
	kill: () => void;
}

export interface RunTarget {
	runId: string;
	workspaceId: string;
	connectionRef: string;
	name: string;
}

export interface RunnerDeps {
	/** Hard ceiling, whatever the command asked for. */
	maxTimeoutMs: number;
	defaultTimeoutMs: number;
	/**
	 * Output goes to the whole workspace rather than to the socket that
	 * pressed the button: a run that starts a database affects everybody
	 * in the project, and the person who started it may well close the
	 * tab. The runner therefore carries the workspace with each run.
	 */
	onOutput: (
		target: RunTarget,
		stream: "stdout" | "stderr",
		chunk: string,
	) => void;
	onExit: (
		target: RunTarget,
		exitCode: number | null,
		killed: boolean,
		reason: string | null,
	) => void;
}

/**
 * The environment a repository command gets.
 *
 * An allowlist, not a filter of the server's own. The server process
 * holds the connection encryption key and the session secret; a command
 * declared in a checkout must not inherit them just because nobody
 * thought to remove them.
 */
function commandEnvironment(
	declared: Record<string, string> | undefined,
): Record<string, string> {
	const inherited: Record<string, string> = {};
	for (const key of ["PATH", "HOME", "LANG", "LC_ALL", "TERM", "TMPDIR"]) {
		const value = process.env[key];
		if (value !== undefined) {
			inherited[key] = value;
		}
	}
	return {
		...inherited,
		// Literal values: there is no expansion, so `$HOME` stays four
		// characters and a command cannot smuggle one in.
		...(declared ?? {}),
		// So a script can tell it is being run by DataGripe rather than by
		// a person, and skip anything interactive.
		DATAGRIPE_RUN: "1",
		CI: "1",
	};
}

/** How long to wait after SIGTERM before SIGKILL. */
const GRACE_MS = 5_000;

export class CommandRunner {
	private readonly active = new Map<
		string,
		{
			child: ReturnType<typeof Bun.spawn>;
			timer: ReturnType<typeof setTimeout> | null;
			target: RunTarget;
		}
	>();

	constructor(private readonly deps: RunnerDeps) {}

	/** Runs in this process's lifetime only; a restart orphans nothing. */
	async start(
		repoRoot: string,
		command: RepoCommand,
		audit: { workspaceId: string; userId: string; connectionRef: string },
	): Promise<RunHandle> {
		const cwd =
			command.cwd === undefined || command.cwd.trim() === ""
				? repoRoot
				: await resolveRepoPath(
						repoRoot,
						command.cwd,
						`The cwd of '${command.name}'`,
					);

		const program = command.run[0];
		if (program === undefined || program.trim() === "") {
			throw new ServiceError(
				ErrorCodes.BadRequest,
				`'${command.name}' has an empty command`,
			);
		}

		// A background command is a service, so it has no deadline: it runs
		// until somebody stops it or the server exits. A task that has not
		// finished in its budget has hung.
		const timeoutMs = command.background
			? null
			: Math.min(
					command.timeoutSeconds === undefined
						? this.deps.defaultTimeoutMs
						: command.timeoutSeconds * 1000,
					this.deps.maxTimeoutMs,
				);
		const runId = crypto.randomUUID();

		log.audit("repo.run", {
			...audit,
			runId,
			name: command.name,
			// The whole argv, so the audit line says what actually ran
			// rather than which button was pressed.
			argv: command.run,
			cwd,
			timeoutMs,
		});

		const child = Bun.spawn(command.run, {
			cwd,
			env: commandEnvironment(command.env),
			stdout: "pipe",
			stderr: "pipe",
			stdin: "ignore",
		});

		const target: RunTarget = {
			runId,
			workspaceId: audit.workspaceId,
			connectionRef: audit.connectionRef,
			name: command.name,
		};
		const timer =
			timeoutMs === null
				? null
				: setTimeout(() => {
						this.stop(
							runId,
							`timed out after ${Math.round(timeoutMs / 1000)}s`,
						);
					}, timeoutMs);
		this.active.set(runId, { child, timer, target });

		void this.pump(target, child.stdout, "stdout");
		void this.pump(target, child.stderr, "stderr");
		void child.exited.then((exitCode) => {
			if (timer !== null) {
				clearTimeout(timer);
			}
			this.active.delete(runId);
			this.deps.onExit(
				target,
				exitCode,
				this.killed.has(runId),
				this.reasons.get(runId) ?? null,
			);
			this.killed.delete(runId);
			this.reasons.delete(runId);
		});

		return {
			runId,
			argv: command.run,
			cwd,
			kill: () => this.stop(runId, "cancelled"),
		};
	}

	private readonly killed = new Set<string>();
	private readonly reasons = new Map<string, string>();

	private async pump(
		target: RunTarget,
		stream: ReadableStream<Uint8Array> | number | undefined,
		which: "stdout" | "stderr",
	): Promise<void> {
		if (stream === undefined || typeof stream === "number") {
			return;
		}
		const decoder = new TextDecoder();
		for await (const chunk of stream) {
			const text = decoder.decode(chunk, { stream: true });
			if (text !== "") {
				this.deps.onOutput(target, which, text);
			}
		}
	}

	/**
	 * SIGTERM, then SIGKILL after a grace period. A command that starts a
	 * database deserves the chance to shut it down cleanly; one that
	 * ignores the chance does not get to hold the slot forever.
	 */
	stop(runId: string, reason: string): boolean {
		const entry = this.active.get(runId);
		if (entry === undefined) {
			return false;
		}
		this.killed.add(runId);
		this.reasons.set(runId, reason);
		entry.child.kill();
		setTimeout(() => {
			if (this.active.has(runId)) {
				entry.child.kill(9);
			}
		}, GRACE_MS);
		return true;
	}

	isRunning(runId: string): boolean {
		return this.active.has(runId);
	}

	/** Every run this process started, killed. Used on shutdown. */
	stopAll(): void {
		for (const runId of [...this.active.keys()]) {
			this.stop(runId, "the server is shutting down");
		}
	}
}

/** Exposed for tests: what the command actually gets. */
export function environmentFor(
	declared: Record<string, string> | undefined,
): Record<string, string> {
	return commandEnvironment(declared);
}

/** Exposed for tests: the resolved working directory rule. */
export function cwdFor(repoRoot: string, command: RepoCommand): string {
	return command.cwd === undefined || command.cwd.trim() === ""
		? repoRoot
		: path.resolve(repoRoot, command.cwd);
}
