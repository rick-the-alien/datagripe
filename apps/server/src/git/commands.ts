import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";
import type { RepoCommand, RepoRunFile } from "@datagripe/contracts";
import {
	DATAGRIPE_DIR,
	RUN_FILE,
	repoRunFileSchema,
} from "@datagripe/contracts";
import { ErrorCodes } from "@datagripe/contracts/errors";
import { ServiceError } from "../connections/service";
import type { AppDb } from "../db/app/pool";
import { fromYaml } from "./yaml";

/**
 * `.datagripe/run.yaml` and the trust that gates it
 * (docs/spec/repo-commands.md).
 *
 * Everything else in `.datagripe/` is data DataGripe interprets. This is
 * a program somebody else wrote, arriving over the network on `git
 * pull`, so the question is not "is this file valid" but "did a person
 * here agree to run *this*".
 *
 * The answer is a hash. The command list is normalised and hashed, a
 * person approves that hash, and any change to it needs a fresh
 * approval. Without that step, `git pull` is remote code execution with
 * a friendly button.
 */

export function runFilePath(repoRoot: string): string {
	return path.join(repoRoot, DATAGRIPE_DIR, RUN_FILE);
}

/**
 * The hash a person approves.
 *
 * Over the *semantic* content — name, argv, cwd, env, timeout — in a
 * fixed shape, so reformatting the YAML or reordering keys does not
 * invalidate an approval, and changing a single argument does. Comments
 * and whitespace are deliberately not in it: they cannot change what
 * runs.
 */
export function hashCommands(commands: RepoCommand[]): string {
	const normalised = commands.map((command) => ({
		name: command.name,
		run: command.run,
		cwd: command.cwd ?? "",
		env: Object.entries(command.env ?? {}).sort(([a], [b]) =>
			a.localeCompare(b),
		),
		timeoutSeconds: command.timeoutSeconds ?? 0,
		// In the hash: flipping a task into an untimed background service
		// is a change to what approving it means.
		background: command.background,
	}));
	return createHash("sha256").update(JSON.stringify(normalised)).digest("hex");
}

/**
 * Read the command list. A repository with no `run.yaml` has none, which
 * is not an error — most repositories will not have one.
 */
export async function readCommands(repoRoot: string): Promise<RepoRunFile> {
	let text: string;
	try {
		text = await readFile(runFilePath(repoRoot), "utf8");
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") {
			return { version: 1, commands: [] };
		}
		throw new ServiceError(
			ErrorCodes.BadRequest,
			`Could not read ${DATAGRIPE_DIR}/${RUN_FILE}: ${error instanceof Error ? error.message : String(error)}`,
		);
	}
	const raw = fromYaml(text, `${DATAGRIPE_DIR}/${RUN_FILE}`);
	const version = (raw as { version?: unknown } | null)?.version;
	if (version !== 1) {
		throw new ServiceError(
			ErrorCodes.BadRequest,
			`${DATAGRIPE_DIR}/${RUN_FILE} has version ${JSON.stringify(version)}, which this DataGripe does not know`,
		);
	}
	const parsed = repoRunFileSchema.safeParse(raw);
	if (!parsed.success) {
		const issues = parsed.error.issues
			.map((issue) => `  ${issue.path.join(".") || "(root)"}: ${issue.message}`)
			.join("\n");
		throw new ServiceError(
			ErrorCodes.BadRequest,
			`${DATAGRIPE_DIR}/${RUN_FILE} is not valid:\n${issues}`,
		);
	}
	assertDistinctNames(parsed.data.commands);
	return parsed.data;
}

function assertDistinctNames(commands: RepoCommand[]): void {
	const seen = new Set<string>();
	for (const command of commands) {
		const key = command.name.trim().toLowerCase();
		if (seen.has(key)) {
			// `repo.run` picks a command by name; two with one name means the
			// button and the thing it runs are not the same decision.
			throw new ServiceError(
				ErrorCodes.BadRequest,
				`Two commands are both called '${command.name.trim()}'`,
			);
		}
		seen.add(key);
	}
}

/* ---- the approval record ---------------------------------------------- */

export interface TrustRecord {
	commandsHash: string;
	approvedBy: string | null;
	approvedAt: string;
}

export async function readTrust(
	appDb: AppDb,
	workspaceId: string,
	datasourceId: string,
): Promise<TrustRecord | null> {
	const rows = await appDb<
		Array<{
			commands_hash: string;
			approved_by: string | null;
			approved_at: Date;
		}>
	>`
		SELECT commands_hash, approved_by, approved_at
		FROM git_datasource_trust
		WHERE workspace_id = ${workspaceId} AND datasource_id = ${datasourceId}
	`;
	const row = rows[0];
	return row === undefined
		? null
		: {
				commandsHash: row.commands_hash,
				approvedBy: row.approved_by,
				approvedAt: row.approved_at.toISOString(),
			};
}

/**
 * Approval is per workspace, not per person.
 *
 * A project is a set of people who already share a database and a
 * checkout; making each of them approve the same command list
 * separately would train everybody to click through it. One person
 * vouches, and the audit line records who.
 */
export async function setTrust(
	appDb: AppDb,
	workspaceId: string,
	datasourceId: string,
	commandsHash: string,
	userId: string,
): Promise<void> {
	await appDb`
		INSERT INTO git_datasource_trust
			(workspace_id, datasource_id, commands_hash, approved_by)
		VALUES (${workspaceId}, ${datasourceId}, ${commandsHash}, ${userId})
		ON CONFLICT (workspace_id, datasource_id) DO UPDATE
			SET commands_hash = EXCLUDED.commands_hash,
				approved_by = EXCLUDED.approved_by,
				approved_at = now()
	`;
}

export async function clearTrust(
	appDb: AppDb,
	workspaceId: string,
	datasourceId: string,
): Promise<void> {
	await appDb`
		DELETE FROM git_datasource_trust
		WHERE workspace_id = ${workspaceId} AND datasource_id = ${datasourceId}
	`;
}
