import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import type {
	ExportConfigFile,
	ExportConfigRequest,
	ExportConfigResult,
	RepoConfig,
} from "@datagripe/contracts";
import {
	CONFIG_FILE,
	DATAGRIPE_DIR,
	DOMAINS_FILE,
	SYNC_FILE,
} from "@datagripe/contracts";
import { ErrorCodes } from "@datagripe/contracts/errors";
import type { ConnectionsService, WorkspaceRef } from "../connections/service";
import { ServiceError } from "../connections/service";
import type { AppDb } from "../db/app/pool";
import {
	type HostFsPolicy,
	isWithin,
	resolveHostDirectory,
} from "../domains/paths";
import { listDomains } from "../domains/service";
import { log } from "../log";
import { renderConfig } from "./config";
import { renderDomainsFile } from "./domainsFile";
import { type GitOptions, workTreeRoot } from "./run";
import { toYaml } from "./yaml";

/**
 * Generating a `.datagripe/` set from a datasource that already exists
 * (docs/spec/git-datasources.md "Exporting a config from an existing
 * datasource").
 *
 * This does **not** convert the datasource. It stays managed or
 * predefined; what you get is a directory you can commit, and adding it
 * back as a git datasource is a separate, deliberate act.
 *
 * The password is never written. The generated config carries a
 * `passwordEnv` name, and the panel says so above the button — a
 * placeholder that looks like a setting is worse than a missing one.
 */

export interface ExportConfigDeps {
	appDb: AppDb;
	connections: ConnectionsService;
	hostFs: HostFsPolicy;
	gitOptions: GitOptions;
}

/** `wallet-prod` → `WALLET_PROD_PASSWORD`. */
export function passwordEnvName(datasourceName: string): string {
	const slug = datasourceName
		.toUpperCase()
		.replaceAll(/[^A-Z0-9]+/g, "_")
		.replace(/^_+|_+$/g, "");
	return `${slug === "" ? "DATASOURCE" : slug}_PASSWORD`;
}

/**
 * A configured absolute path expressed relative to the target
 * repository, or null when it does not live inside it.
 */
export function relativise(repoRoot: string, absolute: string): string | null {
	if (!isWithin(repoRoot, absolute)) {
		return null;
	}
	const relative = path.relative(repoRoot, absolute);
	// The root itself is not a path pair: a section titled after the
	// whole checkout is the file tree, not a shortcut into it.
	return relative === "" ? null : relative.split(path.sep).join("/");
}

export async function runExportConfig(
	deps: ExportConfigDeps,
	workspace: WorkspaceRef,
	userId: string,
	request: ExportConfigRequest,
): Promise<ExportConfigResult> {
	const target = await resolveHostDirectory(
		request.targetDir,
		deps.hostFs,
		"target directory",
	);
	// The repository root, when the target is in one. A config written
	// into a subdirectory would have every path relative to the wrong
	// thing, so the root is what paths are relativised against.
	const repoRoot = await workTreeRoot(target, deps.gitOptions).catch(
		() => target,
	);

	const connection = (await deps.connections.listConnections(workspace)).find(
		(entry) => entry.id === request.connectionRef,
	);
	if (connection === undefined) {
		throw new ServiceError(ErrorCodes.NotFound, "No such datasource");
	}
	if (connection.source === "git") {
		throw new ServiceError(
			ErrorCodes.BadRequest,
			"That datasource already comes from a repository — its .datagripe/ is the original",
		);
	}

	const passwordEnv = passwordEnvName(connection.name);
	const outsideRepo: Array<{ name: string; path: string }> = [];
	const paths: RepoConfig["paths"] = [];
	for (const entry of connection.paths) {
		const relative = relativise(repoRoot, entry.path);
		if (relative === null) {
			outsideRepo.push({ name: entry.name, path: entry.path });
			continue;
		}
		paths.push({ name: entry.name, path: relative });
	}

	const files: ExportConfigFile[] = [];
	const add = async (relative: string, content: string): Promise<void> => {
		files.push({
			path: relative,
			content,
			exists: await Bun.file(path.join(target, relative))
				.exists()
				.catch(() => false),
		});
	};

	await add(
		`${DATAGRIPE_DIR}/${CONFIG_FILE}`,
		withOutsideNote(
			renderConfig({
				version: 1,
				datasource: {
					name: connection.name,
					adapter: connection.adapter,
					...(connection.host !== null ? { host: connection.host } : {}),
					...(connection.port !== null ? { port: connection.port } : {}),
					database: connection.databaseName,
					...(connection.username !== null
						? { username: connection.username }
						: {}),
					passwordEnv,
					noPassword: false,
					tlsMode: connection.tlsMode ?? "disable",
					// Not a secret, and part of the definition: a teammate who
					// clones this should get the same `search_path`, or their
					// unqualified names resolve somewhere else.
					params: connection.params,
					readOnly: connection.readOnly,
					showAllSchemas: connection.showAllSchemas,
				},
				paths,
			}),
			outsideRepo,
		),
	);

	// A sync dir only when the configured export path is inside this
	// repository. Anywhere else and the relative path would be a lie.
	const syncRelative =
		connection.domainExportPath === null
			? null
			: relativise(repoRoot, connection.domainExportPath);
	if (syncRelative !== null) {
		await add(
			`${DATAGRIPE_DIR}/${SYNC_FILE}`,
			toYaml(
				{ version: 1, sync: { dir: syncRelative, includeAccessReports: true } },
				[
					"Where DataGripe writes this datasource's domain dump.",
					"docs/spec/git-datasources.md",
				],
			),
		);
	}

	const { domains: allDomains, tags } = await listDomains(
		deps.appDb,
		workspace.id,
		request.connectionRef,
	);
	// Hidden domains are a local shelf and stay out of the committed file
	// (docs/spec/domains.md "Hidden domains").
	const domains = allDomains.filter((domain) => !domain.hidden);
	const visibleIds = new Set(domains.map((domain) => domain.id));
	if (domains.length > 0) {
		const byDomain = new Map<string, (typeof tags)[number]["target"][]>();
		for (const tag of tags) {
			if (!visibleIds.has(tag.domainId)) {
				continue;
			}
			const list = byDomain.get(tag.domainId) ?? [];
			list.push(tag.target);
			byDomain.set(tag.domainId, list);
		}
		await add(
			`${DATAGRIPE_DIR}/${DOMAINS_FILE}`,
			renderDomainsFile({
				version: 1,
				connection: {
					ref: connection.id,
					name: connection.name,
					engine: connection.adapter,
				},
				domains: [...domains]
					.sort((a, b) => a.name.localeCompare(b.name))
					.map((domain) => ({
						name: domain.name,
						colour: domain.colour,
						description: domain.description,
						includeData: domain.includeData,
						objects: (byDomain.get(domain.id) ?? []).sort(
							(a, b) =>
								a.schema.localeCompare(b.schema) ||
								a.name.localeCompare(b.name) ||
								a.kind.localeCompare(b.kind),
						),
					})),
			}),
		);
	}

	if (request.dryRun) {
		return { files, written: false, passwordEnv, outsideRepo };
	}

	const clashes = files.filter((file) => file.exists).map((file) => file.path);
	if (clashes.length > 0 && !request.overwrite) {
		throw new ServiceError(
			ErrorCodes.Conflict,
			`Already there: ${clashes.join(", ")}. Confirm the overwrite to replace them.`,
		);
	}

	await mkdir(path.join(target, DATAGRIPE_DIR), { recursive: true });
	for (const file of files) {
		await writeFile(path.join(target, file.path), file.content, "utf8");
	}
	log.audit("datasource.export-config", {
		workspaceId: workspace.id,
		userId,
		connectionRef: request.connectionRef,
		target,
		files: files.length,
	});
	return { files, written: true, passwordEnv, outsideRepo };
}

/**
 * A path that does not sit inside the target repository is written as a
 * comment with its absolute path, never as a broken relative one.
 * Silently dropping it is how a teammate ends up with three of your four
 * sections.
 */
function withOutsideNote(
	yaml: string,
	outside: Array<{ name: string; path: string }>,
): string {
	if (outside.length === 0) {
		return yaml;
	}
	const lines = [
		"",
		"# These paths are configured on the datasource but live outside this",
		"# repository, so they could not be written as relative paths. Move",
		"# them into the checkout, or drop them.",
		...outside.flatMap((entry) => [
			`#   - name: ${entry.name}`,
			`#     path: ${entry.path}`,
		]),
	];
	return `${yaml}${lines.join("\n")}\n`;
}
