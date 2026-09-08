import { z } from "zod";

/**
 * Commands a repository declares and DataGripe can run
 * (docs/spec/repo-commands.md).
 *
 * This is the one feature in `.datagripe/` that executes something, and
 * it is treated accordingly. Everything else in that directory is data
 * DataGripe interprets; this is a program somebody else wrote, arriving
 * over the network on `git pull`.
 *
 * Three rules carry the whole design:
 *
 * - **argv, never a shell.** `run` is an array. There is no string form
 *   and no interpolation, so there is nothing to quote and nothing to
 *   inject into.
 * - **Trust is explicit and re-earned.** The command list is hashed; a
 *   person approves that hash, and any change to it — including one a
 *   pull brought in — needs a fresh approval before anything runs.
 *   Without this, `git pull` is remote code execution.
 * - **Never automatic.** No run on open, on clone, on pull or on save.
 */

export const RUN_FILE = "run.yaml";

/** Short: it is a button label in a 240px rail. */
export const repoCommandNameSchema = z.string().min(1).max(60);

export const repoCommandSchema = z.object({
	name: repoCommandNameSchema,
	/** One sentence, shown under the button. */
	description: z.string().max(300).default(""),
	/**
	 * The program and its arguments, already split. An array rather than
	 * a command line: a string would need a parser, and a parser is a
	 * quoting bug waiting for a filename with a space in it.
	 */
	run: z.array(z.string().min(1).max(1024)).min(1).max(64),
	/**
	 * Working directory, relative to the work tree root. Defaults to the
	 * root itself. Absolute paths and `..` are refused, as everywhere in
	 * this directory.
	 */
	cwd: z.string().max(1024).optional(),
	/**
	 * Environment variables to set for this command. Values are literal —
	 * there is no expansion, so `$HOME` is the four characters.
	 */
	env: z.record(z.string(), z.string()).optional(),
	/** Seconds. Capped by REPO_COMMAND_TIMEOUT_MS whatever this says. */
	timeoutSeconds: z.number().int().positive().max(3600).optional(),
	/**
	 * A long-running service rather than a task: a database to leave up,
	 * not a script that finishes.
	 *
	 * The difference that matters is the timeout. A task that has not
	 * finished in ten minutes has hung and gets killed; a database that
	 * has been up for ten minutes is working. A background command has no
	 * timeout and runs until somebody stops it or the server exits —
	 * which is why it is declared in the file and visible in the approval
	 * list, rather than inferred from how long something happens to take.
	 */
	background: z.boolean().default(false),
});

export type RepoCommand = z.infer<typeof repoCommandSchema>;

export const repoRunFileSchema = z.looseObject({
	version: z.literal(1),
	commands: z.array(repoCommandSchema).max(20).default([]),
});

export type RepoRunFile = z.infer<typeof repoRunFileSchema>;

/* ---- trust ------------------------------------------------------------ */

/**
 * What the datasource page and the sidebar need to know before offering
 * to run anything.
 */
export const repoCommandsStateSchema = z.object({
	connectionRef: z.string().min(1).max(255),
	/** Empty when the repository declares none, or the feature is off. */
	commands: z.array(repoCommandSchema),
	/**
	 * sha256 over the normalised command list. What a person approves,
	 * and what a pull can invalidate.
	 */
	commandsHash: z.string(),
	/** The hash somebody in this workspace approved, if any. */
	approvedHash: z.string().nullable(),
	approvedBy: z.string().nullable(),
	approvedAt: z.iso.datetime().nullable(),
	/**
	 * True when `approvedHash` matches `commandsHash`. False covers both
	 * "never approved" and "changed since it was approved", and the UI
	 * says which — the second is the one worth reading carefully.
	 */
	trusted: z.boolean(),
	/** Why running is unavailable at all: the feature gate, usually. */
	unavailable: z.string().nullable(),
});

export type RepoCommandsState = z.infer<typeof repoCommandsStateSchema>;

export const repoCommandsRequestSchema = z.object({
	connectionRef: z.string().min(1).max(255),
});

export type RepoCommandsRequest = z.infer<typeof repoCommandsRequestSchema>;

/**
 * Approve the command list as it stands right now.
 *
 * The hash is sent by the client and must match what the server just
 * read off disk. That is not belt-and-braces: it is what stops a race
 * where the file changes between the person reading it and pressing
 * approve, so what they approved is what they saw.
 */
export const repoTrustRequestSchema = z.object({
	connectionRef: z.string().min(1).max(255),
	commandsHash: z.string().min(16).max(128),
	/** false withdraws approval. */
	approve: z.boolean().default(true),
	idempotencyKey: z.string().min(8).max(128),
});

export type RepoTrustRequest = z.infer<typeof repoTrustRequestSchema>;

/* ---- running ---------------------------------------------------------- */

export const repoRunRequestSchema = z.object({
	connectionRef: z.string().min(1).max(255),
	/** The command's `name`, matched against the file as it is now. */
	name: repoCommandNameSchema,
	idempotencyKey: z.string().min(8).max(128),
});

export type RepoRunRequest = z.infer<typeof repoRunRequestSchema>;

export const repoRunStartedSchema = z.object({
	runId: z.uuid(),
	connectionRef: z.string(),
	name: z.string(),
	/** Exactly what is being executed, so the pane can show it. */
	argv: z.array(z.string()),
	cwd: z.string(),
});

export type RepoRunStarted = z.infer<typeof repoRunStartedSchema>;

export const repoRunCancelRequestSchema = z.object({
	runId: z.uuid(),
});

export type RepoRunCancelRequest = z.infer<typeof repoRunCancelRequestSchema>;

/** One chunk of output, in arrival order. */
export const repoRunOutputPayloadSchema = z.object({
	runId: z.uuid(),
	stream: z.enum(["stdout", "stderr"]),
	chunk: z.string(),
});

export type RepoRunOutputPayload = z.infer<typeof repoRunOutputPayloadSchema>;

export const repoRunExitPayloadSchema = z.object({
	runId: z.uuid(),
	exitCode: z.number().int().nullable(),
	/** Set when the run was killed rather than exiting on its own. */
	killed: z.boolean(),
	reason: z.string().nullable(),
});

export type RepoRunExitPayload = z.infer<typeof repoRunExitPayloadSchema>;
