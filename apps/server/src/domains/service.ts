import type {
	Domain,
	DomainDeleteRequest,
	DomainListResult,
	DomainTag,
	DomainTagRequest,
	DomainTarget,
	DomainUpsertRequest,
} from "@datagripe/contracts";
import { ErrorCodes } from "@datagripe/contracts/errors";
import { ServiceError } from "../connections/service";
import type { AppDb } from "../db/app/pool";
import { log } from "../log";

/**
 * Domain CRUD and tagging (docs/spec/domains.md).
 *
 * Everything here is scoped to `(workspaceId, connectionRef)`. The one
 * invariant worth stating twice: an object has at most one domain, and
 * that cannot be a database constraint because the datasource identity
 * lives on `domains` rather than on `domain_tags`. It is enforced by
 * `tag()` in a single transaction.
 */

type DomainRow = {
	id: string;
	name: string;
	colour: number;
	description: string;
	include_data: boolean;
	hidden: boolean;
	sort_order: number;
};

type TagRow = {
	domain_id: string;
	schema: string;
	name: string;
	kind: DomainTarget["kind"];
};

function rowToDomain(row: DomainRow): Domain {
	return {
		id: row.id,
		name: row.name,
		colour: row.colour,
		description: row.description,
		includeData: row.include_data,
		hidden: row.hidden,
		sortOrder: row.sort_order,
	};
}

function rowToTag(row: TagRow): DomainTag {
	return {
		domainId: row.domain_id,
		target: { schema: row.schema, name: row.name, kind: row.kind },
	};
}

export async function listDomains(
	appDb: AppDb,
	workspaceId: string,
	connectionRef: string,
): Promise<DomainListResult> {
	const domains = await appDb<DomainRow[]>`
		SELECT id, name, colour, description, include_data, hidden, sort_order
		FROM domains
		WHERE workspace_id = ${workspaceId} AND connection_ref = ${connectionRef}
		ORDER BY sort_order, name
	`;
	const tags = await appDb<TagRow[]>`
		SELECT t.domain_id, t.schema, t.name, t.kind
		FROM domain_tags t
		JOIN domains d ON d.id = t.domain_id
		WHERE d.workspace_id = ${workspaceId} AND d.connection_ref = ${connectionRef}
		ORDER BY t.schema, t.name
	`;
	return { domains: domains.map(rowToDomain), tags: tags.map(rowToTag) };
}

export async function upsertDomain(
	appDb: AppDb,
	workspaceId: string,
	request: DomainUpsertRequest,
): Promise<{ domain: Domain }> {
	if (request.id === undefined) {
		const rows = await appDb<DomainRow[]>`
			INSERT INTO domains
				(workspace_id, connection_ref, name, colour, description,
				 sort_order, include_data, hidden)
			VALUES (${workspaceId}, ${request.connectionRef}, ${request.name},
				${request.colour}, ${request.description}, ${request.sortOrder},
				${request.includeData}, ${request.hidden})
			ON CONFLICT (workspace_id, connection_ref, name) DO NOTHING
			RETURNING id, name, colour, description, include_data, hidden,
				sort_order
		`;
		const row = rows[0];
		if (row === undefined) {
			throw new ServiceError(
				ErrorCodes.Conflict,
				`A domain named '${request.name}' already exists on this datasource`,
			);
		}
		log.audit("domain.create", {
			workspaceId,
			connectionRef: request.connectionRef,
			name: request.name,
		});
		return { domain: rowToDomain(row) };
	}

	const rows = await appDb<DomainRow[]>`
		UPDATE domains SET
			name = ${request.name},
			colour = ${request.colour},
			description = ${request.description},
			sort_order = ${request.sortOrder},
			include_data = ${request.includeData},
			hidden = ${request.hidden}
		WHERE id = ${request.id}
			AND workspace_id = ${workspaceId}
			AND connection_ref = ${request.connectionRef}
		RETURNING id, name, colour, description, include_data, hidden,
			sort_order
	`;
	const row = rows[0];
	if (row === undefined) {
		throw new ServiceError(ErrorCodes.NotFound, "No such domain");
	}
	log.audit("domain.update", {
		workspaceId,
		connectionRef: request.connectionRef,
		domainId: row.id,
	});
	return { domain: rowToDomain(row) };
}

/**
 * Clears the domains an import is about to replace
 * (docs/spec/domains.md "Hidden domains").
 *
 * Visible domains go, because the file is the whole opinion about them.
 * Hidden ones stay: a shelf is local, it never reached the file, and
 * reporting it as removed would be a lie about what the import is doing.
 *
 * The one shelf that cannot survive is one the file also names — the
 * unique index on `(workspace_id, connection_ref, name)` leaves no third
 * option, and a failed import is worse than an unhidden shelf. One
 * statement per name rather than an array parameter, per
 * `files/service.ts`: the driver does not build an array literal from a
 * JS array.
 *
 * Takes a handle so the caller can run it inside its transaction; a
 * half-applied replace would leave the datasource tagged by two
 * different opinions at once.
 */
export async function clearImportedDomains(
	db: AppDb,
	workspaceId: string,
	connectionRef: string,
	incomingNames: readonly string[],
): Promise<void> {
	await db`
		DELETE FROM domains
		WHERE workspace_id = ${workspaceId}
			AND connection_ref = ${connectionRef}
			AND hidden = false
	`;
	for (const name of incomingNames) {
		await db`
			DELETE FROM domains
			WHERE workspace_id = ${workspaceId}
				AND connection_ref = ${connectionRef}
				AND name = ${name}
		`;
	}
}

/**
 * Deleting a domain untags its objects rather than failing. The count
 * comes back so the caller can say how many decisions just evaporated —
 * a domain with 30 tags is 30 decisions.
 */
export async function deleteDomain(
	appDb: AppDb,
	workspaceId: string,
	request: DomainDeleteRequest,
): Promise<{ untagged: number }> {
	return appDb.begin(async (tx) => {
		const owned = await tx<Array<{ id: string }>>`
			SELECT id FROM domains
			WHERE id = ${request.id}
				AND workspace_id = ${workspaceId}
				AND connection_ref = ${request.connectionRef}
		`;
		if (owned[0] === undefined) {
			throw new ServiceError(ErrorCodes.NotFound, "No such domain");
		}
		const counted = await tx<Array<{ count: string }>>`
			SELECT count(*)::text AS count FROM domain_tags
			WHERE domain_id = ${request.id}
		`;
		await tx`DELETE FROM domains WHERE id = ${request.id}`;
		const untagged = Number(counted[0]?.count ?? "0");
		log.audit("domain.delete", {
			workspaceId,
			connectionRef: request.connectionRef,
			domainId: request.id,
			untagged,
		});
		return { untagged };
	});
}

/**
 * Batch assign, or untag with `domainId: null`.
 *
 * The delete-then-insert is the one-domain-per-object invariant: the
 * delete spans every domain of the datasource, not just the target one,
 * so "move to another domain" cannot leave the old tag behind.
 */
export async function tag(
	appDb: AppDb,
	workspaceId: string,
	userId: string,
	request: DomainTagRequest,
): Promise<DomainListResult> {
	await appDb.begin(async (tx) => {
		if (request.domainId !== null) {
			const owned = await tx<Array<{ id: string }>>`
				SELECT id FROM domains
				WHERE id = ${request.domainId}
					AND workspace_id = ${workspaceId}
					AND connection_ref = ${request.connectionRef}
			`;
			if (owned[0] === undefined) {
				throw new ServiceError(ErrorCodes.NotFound, "No such domain");
			}
		}
		for (const target of request.targets) {
			await tx`
				DELETE FROM domain_tags
				WHERE schema = ${target.schema}
					AND name = ${target.name}
					AND kind = ${target.kind}
					AND domain_id IN (
						SELECT id FROM domains
						WHERE workspace_id = ${workspaceId}
							AND connection_ref = ${request.connectionRef}
					)
			`;
			if (request.domainId !== null) {
				await tx`
					INSERT INTO domain_tags (domain_id, schema, name, kind, tagged_by)
					VALUES (${request.domainId}, ${target.schema}, ${target.name},
						${target.kind}, ${userId})
				`;
			}
		}
	});
	log.audit("domain.tag", {
		workspaceId,
		connectionRef: request.connectionRef,
		domainId: request.domainId,
		targets: request.targets.length,
		userId,
	});
	return listDomains(appDb, workspaceId, request.connectionRef);
}
