import { mkdir, readFile, realpath, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import type {
	RepoConfig,
	RepoDomainsFile,
	RepoPath,
	RepoSyncFile,
} from "@datagripe/contracts";
import {
	CONFIG_FILE,
	DATAGRIPE_DIR,
	DOMAINS_FILE,
	repoConfigSchema,
	repoDomainsFileSchema,
	repoSyncFileSchema,
	SYNC_FILE,
} from "@datagripe/contracts";
import { ErrorCodes } from "@datagripe/contracts/errors";
import { ServiceError } from "../connections/service";
import { isWithin } from "../domains/paths";
import { renderDomainsFile } from "./domainsFile";
import { fromYaml, toYaml, unknownTopLevel } from "./yaml";

export { renderDomainsFile };

/**
 * Reading and writing `.datagripe/` (docs/spec/git-datasources.md
 * "The `.datagripe` directory").
 *
 * Three files rather than one, split by feature. A config that is
 * "really just connection info and branding" stays readable in a diff
 * and stays stable; a domain dump churns every time somebody tags a
 * table, and burying the connection under three hundred lines of object
 * list means every tagging change shows up as a change to the file that
 * defines the database.
 */

export function datagripeDir(repoRoot: string): string {
	return path.join(repoRoot, DATAGRIPE_DIR);
}

export function configPath(repoRoot: string): string {
	return path.join(repoRoot, DATAGRIPE_DIR, CONFIG_FILE);
}

export function syncPath(repoRoot: string): string {
	return path.join(repoRoot, DATAGRIPE_DIR, SYNC_FILE);
}

export function domainsPath(repoRoot: string): string {
	return path.join(repoRoot, DATAGRIPE_DIR, DOMAINS_FILE);
}

/** True when a changed file is one of ours, so a pull can reload. */
export function isDatagripeFile(repoRelative: string): boolean {
	return repoRelative.split(/[\\/]/)[0] === DATAGRIPE_DIR;
}

/**
 * Resolve a repo-relative path against the work tree root, and prove the
 * result is still inside it.
 *
 * The schema already rejected `/etc` and `../`, but a symlink committed
 * into the repository passes every lexical test there is — so the target
 * is resolved with `realpath` and checked again. A committed file that
 * could name a directory outside the checkout would be a remote read
 * primitive with extra steps.
 */
export async function resolveRepoPath(
	repoRoot: string,
	relative: string,
	label: string,
): Promise<string> {
	const trimmed = relative.replace(/^\.\//, "").replace(/[\\/]+$/, "");
	if (trimmed === "" || path.isAbsolute(trimmed)) {
		throw new ServiceError(
			ErrorCodes.BadRequest,
			`${label} must be relative to the repository root: ${relative}`,
		);
	}
	const joined = path.resolve(repoRoot, trimmed);
	if (!isWithin(repoRoot, joined)) {
		throw new ServiceError(
			ErrorCodes.Forbidden,
			`${label} is outside the repository: ${relative}`,
		);
	}
	let real: string;
	try {
		real = await realpath(joined);
	} catch {
		throw new ServiceError(
			ErrorCodes.NotFound,
			`${label} does not exist in the repository: ${relative}`,
		);
	}
	const realRoot = await realpath(repoRoot).catch(() => repoRoot);
	if (!isWithin(realRoot, real)) {
		throw new ServiceError(
			ErrorCodes.Forbidden,
			`${label} resolves outside the repository: ${relative}`,
		);
	}
	return real;
}

async function readIfPresent(file: string): Promise<string | null> {
	try {
		return await readFile(file, "utf8");
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") {
			return null;
		}
		throw new ServiceError(
			ErrorCodes.BadRequest,
			`Could not read ${file}: ${error instanceof Error ? error.message : String(error)}`,
		);
	}
}

function formatIssues(
	file: string,
	error: { issues: Array<{ path: PropertyKey[]; message: string }> },
): never {
	const issues = error.issues
		.map((issue) => `  ${issue.path.join(".") || "(root)"}: ${issue.message}`)
		.join("\n");
	throw new ServiceError(
		ErrorCodes.BadRequest,
		`${file} is not a valid DataGripe config:\n${issues}`,
	);
}

export interface LoadedConfig {
	config: RepoConfig;
	/** Top-level keys DataGripe does not know, to put back on write. */
	extra: Record<string, unknown>;
	/** mtime+size of the file, the cache key for the in-memory copy. */
	stamp: string;
}

/**
 * Read `.datagripe/config.yaml`. A repository without one is not a
 * datasource, and says so with the path it looked in rather than being
 * adopted as an empty datasource nobody can use.
 */
export async function readConfig(repoRoot: string): Promise<LoadedConfig> {
	const file = configPath(repoRoot);
	const text = await readIfPresent(file);
	if (text === null) {
		throw new ServiceError(
			ErrorCodes.NotFound,
			`No ${DATAGRIPE_DIR}/${CONFIG_FILE} in ${repoRoot} — this repository is not a DataGripe datasource`,
		);
	}
	const raw = fromYaml(text, `${DATAGRIPE_DIR}/${CONFIG_FILE}`);
	assertKnownVersion(raw, `${DATAGRIPE_DIR}/${CONFIG_FILE}`);
	assertNoInlinePassword(raw);
	const parsed = repoConfigSchema.safeParse(raw);
	if (!parsed.success) {
		formatIssues(`${DATAGRIPE_DIR}/${CONFIG_FILE}`, parsed.error);
	}
	assertDistinctPathNames(parsed.data.paths);
	const info = await stat(file);
	return {
		config: parsed.data,
		extra: unknownTopLevel(raw, ["version", "datasource", "branding", "paths"]),
		stamp: `${info.mtimeMs}:${info.size}`,
	};
}

/**
 * A file whose `version` DataGripe does not know refuses the whole
 * datasource rather than reading the parts it recognises — a
 * half-understood connection definition points at the wrong database.
 */
function assertKnownVersion(raw: unknown, file: string): void {
	if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
		throw new ServiceError(
			ErrorCodes.BadRequest,
			`${file} is empty or is not a mapping`,
		);
	}
	const version = (raw as { version?: unknown }).version;
	if (version !== 1) {
		throw new ServiceError(
			ErrorCodes.BadRequest,
			`${file} has version ${JSON.stringify(version)}, which this DataGripe does not know. Upgrade rather than guessing at it.`,
		);
	}
}

/**
 * Refused, not deprecated. `connections.json` can get away with
 * "development only" because it is gitignored; this file is the
 * opposite of gitignored.
 */
function assertNoInlinePassword(raw: unknown): void {
	const datasource = (raw as { datasource?: unknown }).datasource;
	if (
		datasource !== null &&
		typeof datasource === "object" &&
		"password" in datasource
	) {
		throw new ServiceError(
			ErrorCodes.BadRequest,
			`${DATAGRIPE_DIR}/${CONFIG_FILE} contains an inline 'password'. This file is committed — use 'passwordEnv' to name an environment variable instead.`,
		);
	}
}

function assertDistinctPathNames(paths: RepoPath[]): void {
	const seen = new Set<string>();
	for (const entry of paths) {
		const key = entry.name.trim().toLowerCase();
		if (seen.has(key)) {
			throw new ServiceError(
				ErrorCodes.BadRequest,
				`Two paths are both called '${entry.name.trim()}' — the sidebar could not tell them apart`,
			);
		}
		seen.add(key);
	}
}

/**
 * Read `.datagripe/sync.yaml`. Absent is a normal state: this datasource
 * has no export target configured yet, and the sync tab writes the file
 * when somebody picks one.
 */
export async function readSync(repoRoot: string): Promise<RepoSyncFile | null> {
	const text = await readIfPresent(syncPath(repoRoot));
	if (text === null) {
		return null;
	}
	const raw = fromYaml(text, `${DATAGRIPE_DIR}/${SYNC_FILE}`);
	assertKnownVersion(raw, `${DATAGRIPE_DIR}/${SYNC_FILE}`);
	const parsed = repoSyncFileSchema.safeParse(raw);
	if (!parsed.success) {
		formatIssues(`${DATAGRIPE_DIR}/${SYNC_FILE}`, parsed.error);
	}
	return parsed.data;
}

export async function writeSync(
	repoRoot: string,
	value: RepoSyncFile,
): Promise<void> {
	const existing = await readIfPresent(syncPath(repoRoot));
	const extra =
		existing === null
			? {}
			: unknownTopLevel(fromYaml(existing, `${DATAGRIPE_DIR}/${SYNC_FILE}`), [
					"version",
					"sync",
				]);
	await mkdir(datagripeDir(repoRoot), { recursive: true });
	await writeFile(
		syncPath(repoRoot),
		toYaml({ version: 1, sync: value.sync, ...extra }, [
			"Where DataGripe writes this datasource's domain dump.",
			"docs/spec/git-datasources.md",
		]),
		"utf8",
	);
}

/**
 * Read the domain file, the round-trip source of truth.
 *
 * Takes the file rather than a directory because it lives in two
 * places: `.datagripe/domains.yaml` for a git datasource, and at the
 * export root for everything else, which has no `.datagripe/` to put it
 * in.
 */
export async function readDomainsFile(
	file: string,
): Promise<RepoDomainsFile | null> {
	const text = await readIfPresent(file);
	if (text === null) {
		return null;
	}
	const raw = fromYaml(text, DOMAINS_FILE);
	assertKnownVersion(raw, DOMAINS_FILE);
	const parsed = repoDomainsFileSchema.safeParse(raw);
	if (!parsed.success) {
		formatIssues(DOMAINS_FILE, parsed.error);
	}
	return parsed.data;
}

/** `config.yaml`, serialised, with unknown top-level keys put back. */
export function renderConfig(
	config: RepoConfig,
	extra: Record<string, unknown> = {},
): string {
	const datasource: Record<string, unknown> = {
		name: config.datasource.name,
		adapter: config.datasource.adapter,
	};
	if (config.datasource.host !== undefined) {
		datasource.host = config.datasource.host;
	}
	if (config.datasource.port !== undefined) {
		datasource.port = config.datasource.port;
	}
	datasource.database = config.datasource.database;
	if (config.datasource.username !== undefined) {
		datasource.username = config.datasource.username;
	}
	if (config.datasource.passwordEnv !== undefined) {
		datasource.passwordEnv = config.datasource.passwordEnv;
	}
	if (config.datasource.noPassword) {
		datasource.noPassword = true;
	}
	datasource.tlsMode = config.datasource.tlsMode;
	datasource.readOnly = config.datasource.readOnly;
	datasource.showAllSchemas = config.datasource.showAllSchemas;

	const out: Record<string, unknown> = { version: 1, datasource };
	if (config.branding !== undefined) {
		out.branding = config.branding;
	}
	out.paths = config.paths.map((entry) => ({
		name: entry.name,
		path: entry.path,
	}));
	return toYaml({ ...out, ...extra }, [
		"DataGripe datasource — docs/spec/git-datasources.md",
		"",
		"This file is committed. It never contains a password:",
		"'passwordEnv' names an environment variable the server resolves.",
	]);
}

/**
 * A directory expressed relative to the repository root, for writing
 * into `sync.yaml`.
 *
 * Refuses rather than guessing when the directory is outside the
 * checkout: `sync.dir` is committed, and a relative path that resolves
 * somewhere else on a teammate's machine is worse than an error here.
 */
export function relativeToRepo(repoRoot: string, directory: string): string {
	const absolute = path.resolve(repoRoot, directory);
	if (!isWithin(repoRoot, absolute)) {
		throw new ServiceError(
			ErrorCodes.BadRequest,
			`The sync directory must be inside the repository (${repoRoot}): ${directory}`,
		);
	}
	const relative = path.relative(repoRoot, absolute);
	if (relative === "") {
		throw new ServiceError(
			ErrorCodes.BadRequest,
			"The sync directory cannot be the repository root — the dump would prune files it did not write",
		);
	}
	return relative.split(path.sep).join("/");
}
