import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import type {
	Domain,
	DomainExportRequest,
	DomainExportResult,
	DomainTarget,
	ExportPlan,
} from "@datagripe/contracts";
import { DOMAINS_FILE, domainTargetKey } from "@datagripe/contracts";
import { ErrorCodes } from "@datagripe/contracts/errors";
import {
	renderDefaultAcl,
	renderFindings,
	renderMatrix,
	renderPolicies,
} from "../access/markdown";
import { buildReport } from "../access/service";
import type { ConnectionsService, WorkspaceRef } from "../connections/service";
import { ServiceError } from "../connections/service";
import type { AppDb } from "../db/app/pool";
import { domainsPath } from "../git/config";
import type { GitDatasourcesService } from "../git/types";
import { listDismissals } from "../gripes/dismissals";
import { log } from "../log";
import {
	buildExport,
	type DataPage,
	type ExportSource,
	type ObjectDdl,
} from "./exporter";
import { type HostFsPolicy, resolveHostDirectory } from "./paths";
import { exportPath, recordRun } from "./runs";
import { listDomains } from "./service";
import { appendPullLog, applyExport } from "./writer";

/**
 * Orchestrating one export (docs/spec/domains.md "Export").
 *
 * This is where the domain tags, the object-view DDL, the grant scan and
 * the access report meet the filesystem. Nothing here decides *what* the
 * files contain — that is `exporter.ts`, kept free of I/O so the
 * determinism rules can be tested without a temporary directory.
 */

export interface ExportDeps {
	appDb: AppDb;
	connections: ConnectionsService;
	/** Present when git datasources are on; their sync dir comes from the
	 * repository rather than from `datasource_export_paths`. */
	gitDatasources?: GitDatasourcesService;
	hostFs: HostFsPolicy;
	maxDataRows: number;
	maxCells: number;
	onProgress?: (done: number, total: number, current: string) => void;
}

export interface ExportTarget {
	/** The directory the dump is written into. */
	root: string;
	/**
	 * Absolute path of `.datagripe/domains.yaml` for a git datasource, or
	 * null when the domain file belongs inside the dump because there is
	 * no `.datagripe/` to put it in.
	 */
	domainsFile: string | null;
}

/**
 * Where this datasource's dump goes.
 *
 * For a git datasource the repository says: `sync.yaml`'s `dir`, already
 * resolved and proven inside the checkout. `datasource_export_paths` is
 * not consulted for one — the repo defines its own sync target, and a
 * second answer in the app database would be a way for two people to
 * disagree about where the dump lives.
 */
export async function resolveExportTarget(
	deps: Pick<ExportDeps, "appDb" | "gitDatasources" | "hostFs">,
	workspaceId: string,
	connectionRef: string,
): Promise<ExportTarget> {
	const entry =
		deps.gitDatasources === undefined
			? null
			: await deps.gitDatasources.entryFor(workspaceId, connectionRef);
	if (entry !== null) {
		if (entry.syncPath === null) {
			throw new ServiceError(
				ErrorCodes.BadRequest,
				"This repository has no .datagripe/sync.yaml yet — set a sync directory on the datasource page",
			);
		}
		return {
			root: await resolveHostDirectory(entry.syncPath, deps.hostFs),
			domainsFile: domainsPath(entry.repoPath),
		};
	}
	const configured = await exportPath(deps.appDb, workspaceId, connectionRef);
	return {
		root: await resolveHostDirectory(configured, deps.hostFs),
		domainsFile: null,
	};
}

/** Every schema the tagged objects live in, for the batched reads. */
function schemasOf(targets: DomainTarget[]): string[] {
	return [...new Set(targets.map((target) => target.schema))].sort();
}

async function accessFiles(
	deps: ExportDeps,
	workspace: WorkspaceRef,
	connectionRef: string,
	schemas: string[],
): Promise<Map<string, string>> {
	const files = new Map<string, string>();
	try {
		const bundle = await buildReport(
			deps.appDb,
			deps.connections,
			workspace,
			{ connectionId: connectionRef, schemas, countOnly: false },
			deps.maxCells,
		);
		const dismissals = await listDismissals(deps.appDb, workspace.id);
		files.set(
			"matrix.md",
			renderMatrix(bundle.result.roles, bundle.result.objects),
		);
		files.set("rls-policies.md", renderPolicies(bundle.result.policies));
		files.set("default-acl.md", renderDefaultAcl(bundle.result.defaultAcl));
		files.set("findings.md", renderFindings(bundle.findings, dismissals));
	} catch (error) {
		// An engine with no access report is not an export failure. The
		// tree is still worth writing; the reports simply are not there.
		log.info("export: no access report", {
			connectionRef,
			reason: error instanceof Error ? error.message : String(error),
		});
	}
	return files;
}

export async function runExport(
	deps: ExportDeps,
	workspace: WorkspaceRef,
	userId: string,
	request: DomainExportRequest,
): Promise<DomainExportResult> {
	const target = await resolveExportTarget(
		deps,
		workspace.id,
		request.connectionRef,
	);
	const root = target.root;

	const { domains, tags } = await listDomains(
		deps.appDb,
		workspace.id,
		request.connectionRef,
	);
	if (domains.length === 0) {
		throw new ServiceError(
			ErrorCodes.BadRequest,
			"Nothing to export — this datasource has no domains yet",
		);
	}

	const byDomain = new Map<string, DomainTarget[]>();
	for (const tag of tags) {
		const list = byDomain.get(tag.domainId) ?? [];
		list.push(tag.target);
		byDomain.set(tag.domainId, list);
	}
	const allTargets = tags.map((tag) => tag.target);
	const schemas = schemasOf(allTargets);

	const connection = (await deps.connections.listConnections(workspace)).find(
		(entry) => entry.id === request.connectionRef,
	);

	const grants = await deps.connections.readGrantStatements(
		workspace,
		request.connectionRef,
		schemas,
	);

	const describe = async (target: DomainTarget): Promise<ObjectDdl> => {
		const described = await deps.connections.describeObject(workspace, {
			connectionId: request.connectionRef,
			schema: target.schema,
			name: target.name,
			kind: target.kind,
		});
		return {
			ddl: described.ddl,
			primaryKey: described.columns
				.filter((column) => column.primaryKey)
				.map((column) => column.name),
			columns: described.columns.map((column) => column.name),
		};
	};

	const readData = async (
		target: DomainTarget,
		orderBy: string[],
		limit: number,
	): Promise<DataPage> => {
		// One row over the cap, so "exactly at the cap" and "truncated" are
		// distinguishable without a second count query.
		const page = await deps.connections.readTable(workspace, {
			connectionId: request.connectionRef,
			schema: target.schema,
			table: target.name,
			kind: "table",
			limit: limit + 1,
			offset: 0,
			sort: orderBy.map((column) => ({
				column,
				direction: "asc" as const,
			})),
			filter: "",
			count: false,
		});
		return {
			columns: page.columns.map((column) => column.name),
			rows: page.rows.slice(0, limit),
			overflowed: page.rows.length > limit,
		};
	};

	const untaggedCount = await countUntagged(
		deps,
		workspace,
		request.connectionRef,
		allTargets,
	);

	const source: ExportSource = {
		connectionRef: request.connectionRef,
		connectionName: connection?.name ?? request.connectionRef,
		engine: connection?.adapter ?? "unknown",
		maxDataRows: deps.maxDataRows,
		describe,
		grants,
		readData,
		accessFiles: await accessFiles(
			deps,
			workspace,
			request.connectionRef,
			schemas,
		),
		untaggedCount,
	};

	let plan: ExportPlan;
	try {
		const built = await buildExport(
			domains,
			byDomain,
			source,
			deps.onProgress,
			// A git datasource keeps its domain file in the repository's own
			// `.datagripe/`, beside the config that defines the datasource,
			// rather than inside the dump.
			target.domainsFile === null ? DOMAINS_FILE : null,
		);
		plan = await applyExport(root, built, { dryRun: request.dryRun });
		if (target.domainsFile !== null && !request.dryRun) {
			await mkdir(path.dirname(target.domainsFile), { recursive: true });
			await writeFile(target.domainsFile, built.domainsFile, "utf8");
		}
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		if (!request.dryRun) {
			await recordRun(
				deps.appDb,
				workspace.id,
				request.connectionRef,
				userId,
				"failed",
				null,
				message,
			);
		}
		throw error;
	}

	// A dry run writes nothing, including no history row: it did nothing,
	// and a history full of previews is a history nobody reads.
	if (request.dryRun) {
		return { plan, runId: null };
	}

	await appendPullLog(root, { actor: userId, plan });
	const runId = await recordRun(
		deps.appDb,
		workspace.id,
		request.connectionRef,
		userId,
		plan.refused > 0 ? "refused" : "ok",
		plan,
		null,
	);
	log.audit("domain.export", {
		workspaceId: workspace.id,
		connectionRef: request.connectionRef,
		userId,
		root,
		written: plan.written,
		deleted: plan.deleted,
		refused: plan.refused,
	});
	return { plan, runId };
}

/**
 * How many objects the datasource reports that no domain claims.
 *
 * This is the number the shell scripts could never show, and the reason
 * the sync tab puts it in the scope line: an object added since the last
 * export is silently missing from a hand-maintained map, and visibly
 * untagged here.
 */
async function countUntagged(
	deps: ExportDeps,
	workspace: WorkspaceRef,
	connectionRef: string,
	tagged: DomainTarget[],
): Promise<number> {
	const seen = new Set(tagged.map(domainTargetKey));
	let untagged = 0;
	let schemas: Array<{ name: string }>;
	try {
		schemas = await deps.connections.schemaChildren(
			workspace,
			connectionRef,
			[],
			false,
		);
	} catch {
		return 0;
	}
	for (const schema of schemas) {
		for (const category of ["tables", "views", "functions", "sequences"]) {
			let children: Array<{ kind: string; name: string }>;
			try {
				children = await deps.connections.schemaChildren(
					workspace,
					connectionRef,
					[
						{ kind: "schema", name: schema.name },
						{ kind: category as "tables", name: category },
					],
					false,
				);
			} catch {
				continue;
			}
			for (const child of children) {
				const key = `${child.kind}:${schema.name}.${child.name}`;
				if (!seen.has(key)) {
					untagged += 1;
				}
			}
		}
	}
	return untagged;
}

/** Domains for one datasource, for callers that only need the list. */
export type { Domain };
