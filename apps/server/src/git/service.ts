import { rm } from "node:fs/promises";
import path from "node:path";
import type {
	ConnectionMetadata,
	DatasourcePath,
	GitDatasource,
	RepoConfig,
	RepoSyncFile,
} from "@datagripe/contracts";
import { ErrorCodes } from "@datagripe/contracts/errors";
import type { ResolvedConnection } from "@datagripe/database-adapters";
import { ServiceError } from "../connections/service";
import type { SecretKeyring } from "../crypto/keyring";
import type { AppDb } from "../db/app/pool";
import { isWithin } from "../domains/paths";
import { log } from "../log";
import type { SsrfPolicy } from "../security/ssrf";
import { readConfig, readSync, resolveRepoPath } from "./config";
import { clone } from "./repo";
import { type GitOptions, workTreeRoot } from "./run";
import {
	deleteRow,
	findRow,
	findSecret,
	type GitDatasourceRow,
	idFromRef,
	insertRow,
	listRows,
	refFor,
} from "./store";
import type {
	GitDatasourceEntry,
	GitDatasourcesServiceWithAdmin,
} from "./types";

/**
 * Git datasources (docs/spec/git-datasources.md).
 *
 * The repository is the definition: `.datagripe/config.yaml` says what
 * the connection is, which directories are worth showing and how it
 * should look, and DataGripe reads it. The row in `git_datasources` is
 * only a pointer at the checkout.
 *
 * The load path is deliberately forgiving in one direction and strict in
 * the other. A repository whose config will not parse is **listed with
 * the reason**, never dropped — a datasource that vanishes when somebody
 * commits a typo is a bad way to find out. A repository whose config
 * asks for something outside the checkout is **refused**, because a
 * committed file that could name `/etc` would be a remote read
 * primitive with extra steps.
 */

export interface GitDatasourcesDeps {
	appDb: AppDb;
	keyring: SecretKeyring;
	ssrf: SsrfPolicy;
	env: Record<string, string | undefined>;
	/** Where clones go. One directory per datasource, under this. */
	reposDir: string;
	gitOptions: GitOptions;
	cloneOptions: GitOptions;
	/** HOST_FS_DISABLED, or GIT_ENABLED being off, turns all of this off. */
	enabled: boolean;
	disabledReason: string;
}

interface CachedConfig {
	stamp: string;
	config: RepoConfig;
	sync: RepoSyncFile | null;
	syncPath: string | null;
	paths: Array<{ name: string; absolute: string }>;
	/** Set when the config would not load; the datasource is listed anyway. */
	problem: string | null;
}

/** Schemes a clone may use. A clone from `/etc` is not a feature. */
const CLONE_SCHEMES = ["https:", "http:", "ssh:", "git:"];

/**
 * Validate a clone URL before any process is spawned.
 *
 * It is the same thing as a connection host — a user-supplied name the
 * server is about to connect to — so it goes through the same SSRF
 * policy. `file://` and bare local paths are refused outright.
 */
export async function assertCloneUrl(
	url: string,
	ssrf: SsrfPolicy,
): Promise<void> {
	const trimmed = url.trim();
	// scp-style: `git@host:org/repo.git`. No scheme, but a real remote.
	const scp = /^([^@/]+@)?([^:/]+):(?!\/)(.+)$/.exec(trimmed);
	if (scp !== null && !trimmed.includes("://")) {
		const host = scp[2];
		if (host === undefined || host === "") {
			throw new ServiceError(ErrorCodes.BadRequest, `Not a git URL: ${url}`);
		}
		await ssrf.assertHostAllowed(host);
		return;
	}
	let parsed: URL;
	try {
		parsed = new URL(trimmed);
	} catch {
		throw new ServiceError(
			ErrorCodes.BadRequest,
			`Not a git URL: ${url}. Use https://, ssh:// or git@host:org/repo.`,
		);
	}
	if (!CLONE_SCHEMES.includes(parsed.protocol)) {
		throw new ServiceError(
			ErrorCodes.Forbidden,
			`Refusing to clone a ${parsed.protocol} URL — DataGripe clones from a remote, not from the local filesystem`,
		);
	}
	await ssrf.assertHostAllowed(parsed.hostname);
}

/** `wallet-prod-9b1f2c3d`: readable, and two `datasource` repos do not collide. */
function checkoutName(url: string, id: string): string {
	const tail = url
		.replace(/\.git$/, "")
		.split(/[/:]/)
		.filter((part) => part !== "")
		.pop();
	const slug = (tail ?? "repo")
		.toLowerCase()
		.replaceAll(/[^a-z0-9]+/g, "-")
		.replace(/^-+|-+$/g, "");
	return `${slug === "" ? "repo" : slug}-${id.replaceAll("-", "").slice(0, 8)}`;
}

export function createGitDatasourcesService(
	deps: GitDatasourcesDeps,
): GitDatasourcesServiceWithAdmin {
	const { appDb, keyring, ssrf, env } = deps;
	const cache = new Map<string, CachedConfig>();
	/** Last config stamp whose path list was reconciled into the table. */
	const reconciled = new Map<string, string>();

	function assertEnabled(): void {
		if (!deps.enabled) {
			throw new ServiceError(ErrorCodes.Forbidden, deps.disabledReason);
		}
	}

	/**
	 * Read (or reuse) the repo's config. Cached against the file's mtime
	 * and size, so editing `config.yaml` in DataGripe and saving it is
	 * picked up on the next read without anything watching the disk.
	 */
	async function loadConfig(repoPath: string): Promise<CachedConfig> {
		try {
			const { config, stamp } = await readConfig(repoPath);
			const cached = cache.get(repoPath);
			if (cached !== undefined && cached.stamp === stamp) {
				return cached;
			}
			const sync = await readSync(repoPath);
			// Every configured directory is resolved and proven inside the
			// checkout here, once, rather than at each use.
			const paths: Array<{ name: string; absolute: string }> = [];
			for (const entry of config.paths) {
				try {
					paths.push({
						name: entry.name.trim(),
						absolute: await resolveRepoPath(
							repoPath,
							entry.path,
							`Path '${entry.name}'`,
						),
					});
				} catch (error) {
					// One unreadable directory is not a broken datasource. The
					// section shows why when it is opened.
					log.info("git datasource: path unavailable", {
						repoPath,
						name: entry.name,
						reason: error instanceof Error ? error.message : String(error),
					});
				}
			}
			let syncAbsolute: string | null = null;
			if (sync !== null) {
				syncAbsolute = await resolveRepoPath(
					repoPath,
					sync.sync.dir,
					"The sync directory",
				).catch(() => path.resolve(repoPath, sync.sync.dir));
			}
			const loaded: CachedConfig = {
				stamp,
				config,
				sync,
				syncPath: syncAbsolute,
				paths,
				problem: null,
			};
			cache.set(repoPath, loaded);
			return loaded;
		} catch (error) {
			const problem =
				error instanceof Error ? error.message : "Could not read the config";
			const loaded: CachedConfig = {
				stamp: `problem:${problem}`,
				// A placeholder so the datasource can still be listed, named
				// after the directory it failed to read.
				config: {
					version: 1,
					datasource: {
						name: path.basename(repoPath),
						adapter: "postgres",
						database: "",
						tlsMode: "disable",
						readOnly: true,
						showAllSchemas: false,
					},
					paths: [],
				} as RepoConfig,
				sync: null,
				syncPath: null,
				paths: [],
				problem,
			};
			cache.set(repoPath, loaded);
			return loaded;
		}
	}

	/**
	 * The repo's path list, mirrored into `datasource_paths`.
	 *
	 * The table becomes a *cache* of what the file says for a git
	 * datasource, never a second opinion about it: the form cannot edit
	 * these, and every reconcile rewrites them from the file. Mirroring
	 * rather than special-casing means `file.list`, `file.open`, the
	 * document origin and the archive-on-removal behaviour are the Phase
	 * 12 machinery, untouched.
	 *
	 * Rows are matched by name so a renamed *directory* keeps its id, and
	 * with it every file already open from it. A row whose name is gone
	 * takes its open documents with it by archiving them, never deleting.
	 */
	async function reconcilePaths(
		workspaceId: string,
		ref: string,
		loaded: CachedConfig,
	): Promise<void> {
		const key = `${workspaceId}:${ref}`;
		if (reconciled.get(key) === loaded.stamp) {
			return;
		}
		await appDb.begin(async (tx) => {
			const existing = await tx<Array<{ id: string; name: string }>>`
				SELECT id, name FROM datasource_paths
				WHERE workspace_id = ${workspaceId} AND connection_ref = ${ref}
			`;
			const byName = new Map(existing.map((row) => [row.name, row.id]));
			const wanted = new Set(loaded.paths.map((entry) => entry.name));
			for (const row of existing) {
				if (wanted.has(row.name)) {
					continue;
				}
				await tx`
					DELETE FROM datasource_paths
					WHERE workspace_id = ${workspaceId} AND id = ${row.id}
				`;
				await tx`
					UPDATE documents SET archived_at = now()
					WHERE workspace_id = ${workspaceId}
						AND origin_path_id = ${row.id}
						AND archived_at IS NULL
				`;
			}
			let position = 0;
			for (const entry of loaded.paths) {
				const id = byName.get(entry.name);
				if (id === undefined) {
					await tx`
						INSERT INTO datasource_paths
							(workspace_id, connection_ref, name, path, position)
						VALUES (${workspaceId}, ${ref}, ${entry.name}, ${entry.absolute}, ${position})
					`;
				} else {
					await tx`
						UPDATE datasource_paths
						SET path = ${entry.absolute}, position = ${position}
						WHERE workspace_id = ${workspaceId} AND id = ${id}
					`;
				}
				position += 1;
			}
		});
		reconciled.set(key, loaded.stamp);
	}

	async function pathsFor(
		workspaceId: string,
		ref: string,
	): Promise<DatasourcePath[]> {
		const rows = await appDb<Array<{ id: string; name: string; path: string }>>`
			SELECT id, name, path FROM datasource_paths
			WHERE workspace_id = ${workspaceId} AND connection_ref = ${ref}
			ORDER BY position, name
		`;
		return rows.map((row) => ({ id: row.id, name: row.name, path: row.path }));
	}

	/**
	 * The secret, and the reason there is not one.
	 *
	 * Environment first, because that is the documented path and the one
	 * that stays commit-safe. The locally stored password is the escape
	 * hatch for a deployment that would rather not export a variable; it
	 * never goes near the repository.
	 */
	async function secretFor(
		datasourceId: string,
		config: RepoConfig,
	): Promise<{ password: string } | { unavailable: string }> {
		const name = config.datasource.passwordEnv;
		if (name !== undefined) {
			const value = env[name];
			if (value !== undefined) {
				return { password: value };
			}
		}
		const stored = await findSecret(appDb, datasourceId);
		if (stored !== null) {
			return {
				password: keyring.decrypt(stored.ciphertext, stored.key_version),
			};
		}
		if (name !== undefined) {
			return {
				unavailable: `${name} is not set on the server, so this datasource has no password yet`,
			};
		}
		return {
			unavailable:
				"No passwordEnv in .datagripe/config.yaml and no password saved here",
		};
	}

	async function entryOf(
		workspaceId: string,
		row: GitDatasourceRow,
	): Promise<GitDatasourceEntry> {
		const loaded = await loadConfig(row.repo_path);
		const ref = refFor(row.id);
		let unavailable = loaded.problem;
		if (unavailable === null) {
			const secret = await secretFor(row.id, loaded.config);
			if ("unavailable" in secret) {
				unavailable = secret.unavailable;
			}
			await reconcilePaths(workspaceId, ref, loaded);
		}
		return {
			ref,
			repoPath: row.repo_path,
			remoteUrl: row.remote_url,
			managedClone: row.managed_clone,
			config: loaded.config,
			sync: loaded.sync,
			syncPath: loaded.syncPath,
			unavailable,
			createdAt: row.created_at.toISOString(),
		};
	}

	function metadataOf(
		workspaceId: string,
		entry: GitDatasourceEntry,
		paths: DatasourcePath[],
	): ConnectionMetadata {
		const source = entry.config.datasource;
		return {
			id: entry.ref,
			workspaceId,
			name: source.name,
			adapter: source.adapter,
			host: source.host ?? null,
			port: source.port ?? null,
			databaseName: source.database,
			username: source.username ?? null,
			tlsMode: source.tlsMode,
			readOnly: source.readOnly,
			showAllSchemas: source.showAllSchemas,
			// The sync dir out of `sync.yaml` *is* this datasource's export
			// path. `datasource_export_paths` is not consulted for a git
			// datasource: the repository says where its own dump goes.
			domainExportPath: entry.syncPath,
			paths,
			source: "git",
			branding:
				entry.config.branding === undefined
					? null
					: {
							colour: entry.config.branding.colour ?? null,
							description: entry.config.branding.description ?? null,
						},
			unavailable: entry.unavailable,
			createdAt: entry.createdAt,
			updatedAt: entry.createdAt,
		};
	}

	async function requireEntry(
		workspaceId: string,
		ref: string,
	): Promise<GitDatasourceEntry> {
		assertEnabled();
		const id = idFromRef(ref);
		if (id === null) {
			throw new ServiceError(
				ErrorCodes.BadRequest,
				`'${ref}' is not a git datasource`,
			);
		}
		const row = await findRow(appDb, workspaceId, id);
		if (row === null) {
			throw new ServiceError(
				ErrorCodes.NotFound,
				"That git datasource no longer exists",
			);
		}
		return entryOf(workspaceId, row);
	}

	return {
		async listMetadata(workspace) {
			if (!deps.enabled) {
				return [];
			}
			const rows = await listRows(appDb, workspace.id);
			const out: ConnectionMetadata[] = [];
			for (const row of rows) {
				const entry = await entryOf(workspace.id, row);
				out.push(
					metadataOf(
						workspace.id,
						entry,
						await pathsFor(workspace.id, entry.ref),
					),
				);
			}
			return out;
		},

		async entryFor(workspaceId, ref) {
			if (!deps.enabled || idFromRef(ref) === null) {
				return null;
			}
			return requireEntry(workspaceId, ref);
		},

		async resolve(workspaceId, ref): Promise<ResolvedConnection | null> {
			const id = idFromRef(ref);
			if (id === null) {
				return null;
			}
			const entry = await requireEntry(workspaceId, ref);
			if (entry.unavailable !== null) {
				throw new ServiceError(ErrorCodes.BadRequest, entry.unavailable);
			}
			const secret = await secretFor(id, entry.config);
			if ("unavailable" in secret) {
				throw new ServiceError(ErrorCodes.BadRequest, secret.unavailable);
			}
			const source = entry.config.datasource;
			if (source.host !== undefined && source.host !== "") {
				await ssrf.assertHostAllowed(source.host);
			}
			return {
				adapter: source.adapter,
				host: source.host ?? "",
				port: source.port ?? 0,
				database: source.database,
				username: source.username ?? "",
				password: secret.password,
				tlsMode: source.tlsMode,
				readOnly: source.readOnly,
			};
		},

		async describe(workspaceId, ref): Promise<GitDatasource | null> {
			if (!deps.enabled || idFromRef(ref) === null) {
				return null;
			}
			const entry = await requireEntry(workspaceId, ref);
			return {
				connectionRef: entry.ref,
				repoPath: entry.repoPath,
				remoteUrl: entry.remoteUrl,
				managedClone: entry.managedClone,
				syncPath: entry.syncPath,
				unavailable: entry.unavailable,
			};
		},

		invalidate(repoPath) {
			if (repoPath === undefined) {
				cache.clear();
				reconciled.clear();
				return;
			}
			cache.delete(repoPath);
			for (const key of [...reconciled.keys()]) {
				reconciled.delete(key);
			}
		},

		requireEntry,

		async add(workspace, userId, request) {
			assertEnabled();
			let repoRoot: string;
			let remoteUrl: string | null = null;
			let managedClone = false;

			if (request.mode === "clone") {
				await assertCloneUrl(request.url, ssrf);
				// The id is minted before the clone so the directory can carry
				// it: two repositories called `datasource` must not collide.
				const provisional = crypto.randomUUID();
				const target = path.join(
					deps.reposDir,
					checkoutName(request.url, provisional),
				);
				await Bun.write(path.join(deps.reposDir, ".keep"), "").catch(() => {});
				repoRoot = await clone(
					request.url.trim(),
					request.branch,
					target,
					deps.cloneOptions,
					{ workspaceId: workspace.id, userId },
				);
				remoteUrl = request.url.trim();
				managedClone = true;
			} else {
				if (!path.isAbsolute(request.path)) {
					throw new ServiceError(
						ErrorCodes.BadRequest,
						`The repository path must be absolute: ${request.path}`,
					);
				}
				const top = await workTreeRoot(request.path, deps.gitOptions);
				// The root itself, not a directory inside it: adopting
				// `~/repo/src` and then writing `~/repo/.datagripe` would be a
				// surprise.
				if (path.resolve(request.path) !== path.resolve(top)) {
					throw new ServiceError(
						ErrorCodes.BadRequest,
						`That is inside a repository whose root is ${top} — add the root instead`,
					);
				}
				repoRoot = top;
			}

			// The repository must actually be a datasource. A clone that is
			// not one is cleaned up rather than left behind as litter.
			try {
				await readConfig(repoRoot);
			} catch (error) {
				if (managedClone) {
					await rm(repoRoot, { recursive: true, force: true }).catch(() => {});
				}
				throw error;
			}

			const existing = await listRows(appDb, workspace.id);
			if (existing.some((row) => row.repo_path === repoRoot)) {
				if (managedClone) {
					await rm(repoRoot, { recursive: true, force: true }).catch(() => {});
				}
				throw new ServiceError(
					ErrorCodes.Conflict,
					"That repository is already a datasource in this project",
				);
			}

			const row = await insertRow(
				appDb,
				workspace.id,
				repoRoot,
				remoteUrl,
				managedClone,
				userId,
			);
			log.audit("git.datasource.add", {
				workspaceId: workspace.id,
				userId,
				connectionRef: refFor(row.id),
				repoPath: repoRoot,
				mode: request.mode,
			});
			cache.delete(repoRoot);
			const entry = await entryOf(workspace.id, row);
			return metadataOf(
				workspace.id,
				entry,
				await pathsFor(workspace.id, entry.ref),
			);
		},

		async remove(workspaceId, ref, deleteCheckout) {
			assertEnabled();
			const id = idFromRef(ref);
			if (id === null) {
				throw new ServiceError(
					ErrorCodes.BadRequest,
					`'${ref}' is not a git datasource`,
				);
			}
			const row = await findRow(appDb, workspaceId, id);
			if (row === null) {
				return;
			}
			await deleteRow(appDb, workspaceId, id);
			// Only a checkout DataGripe made, and only under the repos home.
			// An adopted directory is never deleted whatever the request says.
			if (
				deleteCheckout &&
				row.managed_clone &&
				isWithin(path.resolve(deps.reposDir), path.resolve(row.repo_path))
			) {
				await rm(row.repo_path, { recursive: true, force: true }).catch(
					() => {},
				);
			}
			log.audit("git.datasource.remove", {
				workspaceId,
				connectionRef: ref,
				repoPath: row.repo_path,
				deleted: deleteCheckout && row.managed_clone,
			});
			cache.delete(row.repo_path);
			reconciled.delete(`${workspaceId}:${ref}`);
		},
	};
}
