import path from "node:path";
import type {
	DomainImportRequest,
	DomainImportResult,
	DomainManifest,
} from "@datagripe/contracts";
import { DOMAINS_FILE } from "@datagripe/contracts";
import { ErrorCodes } from "@datagripe/contracts/errors";
import type { ConnectionsService, WorkspaceRef } from "../connections/service";
import { ServiceError } from "../connections/service";
import type { AppDb } from "../db/app/pool";
import { readDomainsFile } from "../git/config";
import type { GitDatasourcesService } from "../git/types";
import { log } from "../log";
import { resolveExportTarget } from "./export";
import type { HostFsPolicy } from "./paths";
import { listDomains } from "./service";

/**
 * Reading a dump's tagging back in (docs/spec/domains.md "Import").
 *
 * How a teammate who pulls the repo gets your tagging, and how tagging
 * survives a workspace being recreated. It reads `manifest.json` and
 * nothing else — the `.sql` files are output.
 *
 * A **replace**, previewed as a diff and applied in one transaction.
 * Tags for objects the datasource does not currently report are imported
 * anyway and show up as stale in the manager, because the alternative is
 * silently losing a tag while a migration is mid-flight.
 *
 * `manifest.json` is not read as a fallback (docs/spec/git-datasources.md):
 * an existing dump is re-exported once, which writes `domains.yaml` and
 * prunes the JSON in the same run.
 */

async function readDomains(file: string): Promise<DomainManifest> {
	const parsed = await readDomainsFile(file);
	if (parsed === null) {
		throw new ServiceError(
			ErrorCodes.NotFound,
			`No ${DOMAINS_FILE} at ${file} — export first, or point at a dump`,
		);
	}
	return {
		version: 1,
		connection: parsed.connection,
		domains: parsed.domains,
	};
}

export interface ImportDeps {
	appDb: AppDb;
	connections: ConnectionsService;
	gitDatasources?: GitDatasourcesService;
	hostFs: HostFsPolicy;
}

export async function runImport(
	deps: ImportDeps,
	workspace: WorkspaceRef,
	userId: string,
	request: DomainImportRequest,
): Promise<DomainImportResult> {
	const target = await resolveExportTarget(
		deps,
		workspace.id,
		request.connectionRef,
	);
	const root = target.root;
	const manifest = await readDomains(
		target.domainsFile ?? path.join(root, DOMAINS_FILE),
	);

	const connection = (await deps.connections.listConnections(workspace)).find(
		(entry) => entry.id === request.connectionRef,
	);
	// An import into the wrong engine fails loudly: PostgreSQL routine
	// names carry identity arguments that mean nothing to MySQL, and a
	// half-matched tag set is worse than none.
	if (
		connection !== undefined &&
		manifest.connection.engine !== connection.adapter
	) {
		throw new ServiceError(
			ErrorCodes.BadRequest,
			`This dump came from ${manifest.connection.engine}; this datasource is ${connection.adapter}`,
		);
	}

	const before = await listDomains(
		deps.appDb,
		workspace.id,
		request.connectionRef,
	);
	const beforeNames = new Set(before.domains.map((domain) => domain.name));
	const afterNames = new Set(manifest.domains.map((domain) => domain.name));

	const domainsAdded = [...afterNames]
		.filter((n) => !beforeNames.has(n))
		.sort();
	const domainsRemoved = [...beforeNames]
		.filter((n) => !afterNames.has(n))
		.sort();
	const domainsChanged = manifest.domains
		.filter((incoming) => {
			const existing = before.domains.find((d) => d.name === incoming.name);
			return (
				existing !== undefined &&
				(existing.colour !== incoming.colour ||
					existing.description !== incoming.description ||
					existing.includeData !== incoming.includeData)
			);
		})
		.map((domain) => domain.name)
		.sort();

	const tagsAfter = manifest.domains.reduce(
		(sum, domain) => sum + domain.objects.length,
		0,
	);

	const result: DomainImportResult = {
		domainsAdded,
		domainsRemoved,
		domainsChanged,
		tagsBefore: before.tags.length,
		tagsAfter,
		dryRun: request.dryRun,
	};

	if (request.dryRun) {
		return result;
	}

	// One transaction: a half-applied replace would leave the datasource
	// tagged by two different opinions at once.
	await deps.appDb.begin(async (tx) => {
		await tx`
			DELETE FROM domains
			WHERE workspace_id = ${workspace.id}
				AND connection_ref = ${request.connectionRef}
		`;
		let order = 0;
		for (const domain of manifest.domains) {
			const rows = await tx<Array<{ id: string }>>`
				INSERT INTO domains
					(workspace_id, connection_ref, name, colour, description,
					 sort_order, include_data)
				VALUES (${workspace.id}, ${request.connectionRef}, ${domain.name},
					${domain.colour}, ${domain.description}, ${order},
					${domain.includeData})
				RETURNING id
			`;
			order += 1;
			const domainId = rows[0]?.id;
			if (domainId === undefined) {
				throw new ServiceError(ErrorCodes.Internal, "Insert returned no row");
			}
			for (const target of domain.objects) {
				await tx`
					INSERT INTO domain_tags (domain_id, schema, name, kind, tagged_by)
					VALUES (${domainId}, ${target.schema}, ${target.name},
						${target.kind}, ${userId})
					ON CONFLICT DO NOTHING
				`;
			}
		}
	});

	log.audit("domain.import", {
		workspaceId: workspace.id,
		connectionRef: request.connectionRef,
		userId,
		root,
		domains: manifest.domains.length,
		tags: tagsAfter,
	});
	return result;
}
