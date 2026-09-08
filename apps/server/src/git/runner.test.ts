import { describe, expect, test } from "bun:test";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type { RepoCommand } from "@datagripe/contracts";
import { CommandRunner, cwdFor, environmentFor } from "./runner";

/**
 * Running a repository's command (docs/spec/repo-commands.md
 * "Running one").
 *
 * Trust is checked before anything reaches the runner, so what is under
 * test here is the execution itself: that it is argv and not a shell,
 * that the environment is an allowlist rather than the server's own, and
 * that a process which overruns is killed and reported as killed.
 */

const AUDIT = { workspaceId: "w-1", userId: "u-1", connectionRef: "git:x" };

function command(
	partial: Partial<RepoCommand> & { run: string[] },
): RepoCommand {
	return {
		name: partial.name ?? "test",
		description: "",
		background: false,
		...partial,
	};
}

/** Run to completion and hand back everything that came out. */
function runOnce(
	root: string,
	spec: RepoCommand,
	deps: Partial<{ maxTimeoutMs: number; defaultTimeoutMs: number }> = {},
): Promise<{
	out: string;
	err: string;
	exitCode: number | null;
	killed: boolean;
	reason: string | null;
}> {
	return new Promise((resolve, reject) => {
		let out = "";
		let err = "";
		const runner = new CommandRunner({
			maxTimeoutMs: deps.maxTimeoutMs ?? 20_000,
			defaultTimeoutMs: deps.defaultTimeoutMs ?? 20_000,
			onOutput: (_target, stream, chunk) => {
				if (stream === "stdout") {
					out += chunk;
				} else {
					err += chunk;
				}
			},
			onExit: (_target, exitCode, killed, reason) =>
				resolve({ out, err, exitCode, killed, reason }),
		});
		runner.start(root, spec, AUDIT).catch(reject);
	});
}

describe("argv, never a shell", () => {
	test("a shell metacharacter is an argument, not a command", async () => {
		// The whole reason `run` is an array. If this ever regresses it
		// regresses silently and catastrophically.
		const root = await mkdtemp(path.join(tmpdir(), "dg-run-"));
		const result = await runOnce(
			root,
			command({ run: ["echo", "hello; rm -rf /tmp/nope"] }),
		);
		expect(result.exitCode).toBe(0);
		expect(result.out.trim()).toBe("hello; rm -rf /tmp/nope");
	});

	test("an argument that looks like a flag is passed through", async () => {
		const root = await mkdtemp(path.join(tmpdir(), "dg-run-"));
		const result = await runOnce(root, command({ run: ["echo", "--amend"] }));
		expect(result.out.trim()).toBe("--amend");
	});

	test("a variable reference is four characters, not an expansion", async () => {
		const root = await mkdtemp(path.join(tmpdir(), "dg-run-"));
		const result = await runOnce(root, command({ run: ["echo", "$HOME"] }));
		expect(result.out.trim()).toBe("$HOME");
	});
});

describe("the environment", () => {
	test("is an allowlist, not the server's own", async () => {
		// The server process holds the connection encryption key and the
		// session secret. A command from a repository must not inherit them
		// because nobody thought to remove them.
		process.env.CONNECTION_ENCRYPTION_KEY = "super-secret-for-this-test";
		process.env.SESSION_SECRET = "also-secret";
		const env = environmentFor(undefined);
		expect(env.CONNECTION_ENCRYPTION_KEY).toBeUndefined();
		expect(env.SESSION_SECRET).toBeUndefined();
		expect(env.PATH).toBeDefined();
		process.env.CONNECTION_ENCRYPTION_KEY = undefined as never;
		process.env.SESSION_SECRET = undefined as never;
	});

	test("declared values are literal and marked as a DataGripe run", () => {
		const env = environmentFor({ GREETING: "$HOME" });
		expect(env.GREETING).toBe("$HOME");
		expect(env.DATAGRIPE_RUN).toBe("1");
	});

	test("reaches the process", async () => {
		const root = await mkdtemp(path.join(tmpdir(), "dg-run-"));
		const result = await runOnce(
			root,
			command({
				run: ["env"],
				env: { DG_EXAMPLE_MARKER: "present" },
			}),
		);
		expect(result.out).toContain("DG_EXAMPLE_MARKER=present");
		expect(result.out).toContain("DATAGRIPE_RUN=1");
		expect(result.out).not.toContain("CONNECTION_ENCRYPTION_KEY");
	});
});

describe("timeouts and cancellation", () => {
	test("a task that overruns is killed and reported as killed", async () => {
		const root = await mkdtemp(path.join(tmpdir(), "dg-run-"));
		const result = await runOnce(
			root,
			command({ run: ["sleep", "30"], timeoutSeconds: 1 }),
			{ maxTimeoutMs: 20_000, defaultTimeoutMs: 20_000 },
		);
		expect(result.killed).toBe(true);
		expect(result.reason).toMatch(/timed out/);
	});

	test("the server ceiling wins over a longer declared timeout", async () => {
		const root = await mkdtemp(path.join(tmpdir(), "dg-run-"));
		const result = await runOnce(
			root,
			command({ run: ["sleep", "30"], timeoutSeconds: 3000 }),
			{ maxTimeoutMs: 1_000, defaultTimeoutMs: 1_000 },
		);
		expect(result.killed).toBe(true);
	});

	test("a background command has no deadline", async () => {
		// A database that has been up for ten minutes is working, not hung.
		const root = await mkdtemp(path.join(tmpdir(), "dg-run-"));
		let exited = false;
		const runner = new CommandRunner({
			maxTimeoutMs: 300,
			defaultTimeoutMs: 300,
			onOutput: () => {},
			onExit: () => {
				exited = true;
			},
		});
		const handle = await runner.start(
			root,
			command({ run: ["sleep", "5"], background: true }),
			AUDIT,
		);
		await Bun.sleep(1_200);
		// Well past a 300ms ceiling, and still going.
		expect(exited).toBe(false);
		expect(runner.isRunning(handle.runId)).toBe(true);
		handle.kill();
	});

	test("cancel stops a run and says so", async () => {
		const root = await mkdtemp(path.join(tmpdir(), "dg-run-"));
		const result = await new Promise<{
			killed: boolean;
			reason: string | null;
		}>((resolve) => {
			const runner = new CommandRunner({
				maxTimeoutMs: 20_000,
				defaultTimeoutMs: 20_000,
				onOutput: () => {},
				onExit: (_target, _code, killed, reason) => resolve({ killed, reason }),
			});
			void runner
				.start(root, command({ run: ["sleep", "30"] }), AUDIT)
				.then((handle) => setTimeout(() => handle.kill(), 100));
		});
		expect(result.killed).toBe(true);
		expect(result.reason).toBe("cancelled");
	});
});

describe("cwd", () => {
	test("defaults to the work tree root", () => {
		expect(cwdFor("/srv/repo", command({ run: ["true"] }))).toBe("/srv/repo");
	});

	test("a relative cwd resolves inside", () => {
		expect(
			cwdFor("/srv/repo", command({ run: ["true"], cwd: "scripts" })),
		).toBe("/srv/repo/scripts");
	});

	test("a cwd that climbs out is refused at run time", async () => {
		// `resolveRepoPath` is the same gate every other path in
		// `.datagripe/` goes through.
		const root = await mkdtemp(path.join(tmpdir(), "dg-run-"));
		const runner = new CommandRunner({
			maxTimeoutMs: 5_000,
			defaultTimeoutMs: 5_000,
			onOutput: () => {},
			onExit: () => {},
		});
		await expect(
			runner.start(
				root,
				command({ run: ["true"], cwd: "../elsewhere" }),
				AUDIT,
			),
		).rejects.toThrow();
		await expect(
			runner.start(root, command({ run: ["true"], cwd: "/etc" }), AUDIT),
		).rejects.toThrow();
	});
});

describe("output", () => {
	test("stdout and stderr are kept apart and both delivered", async () => {
		const root = await mkdtemp(path.join(tmpdir(), "dg-run-"));
		const result = await runOnce(
			root,
			command({
				run: ["bun", "-e", "console.log('out'); console.error('err')"],
			}),
		);
		expect(result.out).toContain("out");
		expect(result.err).toContain("err");
		expect(result.exitCode).toBe(0);
	});

	test("a non-zero exit is reported rather than thrown", async () => {
		const root = await mkdtemp(path.join(tmpdir(), "dg-run-"));
		const result = await runOnce(
			root,
			command({ run: ["bun", "-e", "process.exit(3)"] }),
		);
		expect(result.exitCode).toBe(3);
		expect(result.killed).toBe(false);
	});
});
