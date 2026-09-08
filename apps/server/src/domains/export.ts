import type {
	Domain,
	DomainExportRequest,
	DomainExportResult,
	DomainTarget,
	ExportPlan,
} from "@datagripe/contracts";
import { domainTargetKey } from "@datagripe/contracts";
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
import { listDismissals } from "../gripes/dismissals";
import { log } from "../log";
import {
	buildExport,
	type DataPage,
	type ExportSource,
	type ObjectDdl,
} from "./exporter";
import { resolveExportRoot } from "./paths";
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
	exportRoots: string[];
	maxDataRows: number;
	maxCells: number;
	onProgress?: (done: number, total: number, current: string) => void;
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
	const configured = await exportPath(
		deps.appDb,
		workspace.id,
		request.connectionRef,
	);
	const root = await resolveExportRoot(configured, deps.exportRoots);

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
		const built = await buildExport(domains, byDomain, source, deps.onProgress);
		plan = await applyExport(root, built, { dryRun: request.dryRun });
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
