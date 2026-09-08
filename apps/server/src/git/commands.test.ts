import { describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { hashCommands, readCommands } from "./commands";

/**
 * `run.yaml` and its hash (docs/spec/repo-commands.md).
 *
 * The hash is the security boundary of this whole feature: a person
 * approves it, and any change to what would run has to invalidate it.
 * So the two properties worth asserting are opposites — **cosmetic edits
 * must not** invalidate an approval (or people learn to re-approve
 * reflexively, which defeats the point), and **any change to what
 * executes must**.
 */

const RUN = `version: 1
commands:
  - name: start database
    description: Starts an embedded PostgreSQL.
    run: ["bun", "run", "scripts/dev-db.ts", "start"]
    background: true
  - name: reset database
    run: ["bun", "run", "scripts/dev-db.ts", "reset"]
    timeoutSeconds: 60
`;

async function repoWith(run: string | null): Promise<string> {
	const root = await mkdtemp(path.join(tmpdir(), "dg-run-"));
	await mkdir(path.join(root, ".datagripe"), { recursive: true });
	if (run !== null) {
		await writeFile(path.join(root, ".datagripe", "run.yaml"), run);
	}
	return root;
}

describe("readCommands", () => {
	test("reads argv, background and timeout", async () => {
		const { commands } = await readCommands(await repoWith(RUN));
		expect(commands).toHaveLength(2);
		expect(commands[0]?.run).toEqual([
			"bun",
			"run",
			"scripts/dev-db.ts",
			"start",
		]);
		expect(commands[0]?.background).toBe(true);
		expect(commands[1]?.timeoutSeconds).toBe(60);
		expect(commands[1]?.background).toBe(false);
	});

	test("no run.yaml means no commands, not an error", async () => {
		// Most repositories will never have one.
		const { commands } = await readCommands(await repoWith(null));
		expect(commands).toEqual([]);
	});

	test("an unknown version refuses the file", async () => {
		await expect(
			readCommands(await repoWith(RUN.replace("version: 1", "version: 7"))),
		).rejects.toThrow(/version 7/);
	});

	test("two commands with one name are refused", async () => {
		// `repo.run` picks by name; two with one name means the button and
		// the thing it runs are not the same decision.
		await expect(
			readCommands(
				await repoWith(
					`${RUN}  - name: Start Database\n    run: ["echo", "hi"]\n`,
				),
			),
		).rejects.toThrow(/both called 'Start Database'/i);
	});

	test("an empty run array is refused by the schema", async () => {
		await expect(
			readCommands(
				await repoWith("version: 1\ncommands:\n  - name: x\n    run: []\n"),
			),
		).rejects.toThrow();
	});

	test("a string command is refused — there is no shell form", async () => {
		// The absence of a string form is the reason there is nothing to
		// quote and nothing to inject into.
		await expect(
			readCommands(
				await repoWith(
					'version: 1\ncommands:\n  - name: x\n    run: "rm -rf /"\n',
				),
			),
		).rejects.toThrow();
	});
});

describe("hashCommands", () => {
	test("is stable across reformatting and key order", async () => {
		const original = await readCommands(await repoWith(RUN));
		const reformatted = await readCommands(
			await repoWith(`# a comment somebody added
version: 1
commands:
  - background: true
    run:
      - bun
      - run
      - scripts/dev-db.ts
      - start
    name: start database
    description: Starts an embedded PostgreSQL.

  - timeoutSeconds: 60
    name: reset database
    run: ["bun", "run", "scripts/dev-db.ts", "reset"]
`),
		);
		// Same commands, differently written: an approval survives.
		expect(hashCommands(reformatted.commands)).toBe(
			hashCommands(original.commands),
		);
	});

	test("changes when a single argument changes", async () => {
		const original = await readCommands(await repoWith(RUN));
		const tampered = await readCommands(
			await repoWith(RUN.replace('"start"', '"start-but-different"')),
		);
		expect(hashCommands(tampered.commands)).not.toBe(
			hashCommands(original.commands),
		);
	});

	test("changes when a command is added", async () => {
		const original = await readCommands(await repoWith(RUN));
		const extra = await readCommands(
			await repoWith(`${RUN}  - name: sneaky\n    run: ["curl", "http://x"]\n`),
		);
		expect(hashCommands(extra.commands)).not.toBe(
			hashCommands(original.commands),
		);
	});

	test("changes when a task is turned into an untimed service", async () => {
		// Flipping `background` changes what approving it means: the
		// process stops being one that gets killed when it overruns.
		const original = await readCommands(await repoWith(RUN));
		const backgrounded = await readCommands(
			await repoWith(
				RUN.replace(
					'    run: ["bun", "run", "scripts/dev-db.ts", "reset"]',
					'    run: ["bun", "run", "scripts/dev-db.ts", "reset"]\n    background: true',
				),
			),
		);
		expect(hashCommands(backgrounded.commands)).not.toBe(
			hashCommands(original.commands),
		);
	});

	test("changes when env or cwd changes", async () => {
		const base = await readCommands(await repoWith(RUN));
		const withEnv = await readCommands(
			await repoWith(
				RUN.replace("    background: true", "    env:\n      A: '1'"),
			),
		);
		const withCwd = await readCommands(
			await repoWith(RUN.replace("    background: true", "    cwd: scripts")),
		);
		expect(hashCommands(withEnv.commands)).not.toBe(
			hashCommands(base.commands),
		);
		expect(hashCommands(withCwd.commands)).not.toBe(
			hashCommands(base.commands),
		);
	});

	test("an empty list still has a hash", async () => {
		// So "approved nothing" is representable rather than a special case.
		expect(hashCommands([])).toMatch(/^[0-9a-f]{64}$/);
	});
});
