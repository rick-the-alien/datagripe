import type {
	AccessObject,
	AccessReportRequest,
	AccessReportResult,
	AccessRoleSetRequest,
	AccessRolesResult,
	DatasourceRole,
	DefaultAclEntry,
	Finding,
} from "@datagripe/contracts";
import { suggestsUntrusted } from "@datagripe/contracts";
import type { AccessReportData } from "@datagripe/database-adapters";
import type { AccessInput } from "@datagripe/gripes";
import { RULES, runRules } from "@datagripe/gripes";
import type { ConnectionsService, WorkspaceRef } from "../connections/service";
import type { AppDb } from "../db/app/pool";
import { log } from "../log";

/**
 * The access report (docs/spec/access-report.md).
 *
 * This module owns two things the adapter deliberately does not: which
 * roles are columns, and which of them is untrusted. DataGripe cannot
 * know either — a datasource may have forty roles and the name of the
 * PostgREST anonymous one is a local convention. So the marks are
 * stored, the UI only ever *suggests*, and every `grant.*` rule stays
 * silent until somebody has confirmed one.
 */

type RoleRow = {
	role_name: string;
	untrusted: boolean;
	authenticator: boolean;
	shown: boolean;
};

async function storedRoles(
	appDb: AppDb,
	workspaceId: string,
	connectionRef: string,
): Promise<Map<string, RoleRow>> {
	const rows = await appDb<RoleRow[]>`
		SELECT role_name, untrusted, authenticator, shown
		FROM datasource_roles
		WHERE workspace_id = ${workspaceId} AND connection_ref = ${connectionRef}
	`;
	return new Map(rows.map((row) => [row.role_name, row]));
}

export async function listRoles(
	appDb: AppDb,
	connections: ConnectionsService,
	workspace: WorkspaceRef,
	connectionId: string,
): Promise<AccessRolesResult> {
	const stored = await storedRoles(appDb, workspace.id, connectionId);
	const authenticator =
		[...stored.values()].find((row) => row.authenticator)?.role_name ?? null;
	const { roles, authenticatorReach } = await connections.readRoles(
		workspace,
		connectionId,
		authenticator,
	);
	// A suggestion is only offered while nothing has been marked. Once a
	// person has decided, the hint stops nagging about the roles they
	// deliberately left alone.
	const anyMarked = [...stored.values()].some((row) => row.untrusted);
	return {
		roles: roles.map((role): DatasourceRole => {
			const row = stored.get(role.name);
			return {
				...role,
				untrusted: row?.untrusted ?? false,
				authenticator: row?.authenticator ?? false,
				// Default the columns to the roles a person is likely to care
				// about: superusers teach the eye to ignore solid rows.
				shown: row?.shown ?? (!role.superuser && role.name !== "postgres"),
				suggestedUntrusted: !anyMarked && suggestsUntrusted(role.name),
			};
		}),
		authenticatorReach,
	};
}

export async function setRoles(
	appDb: AppDb,
	workspaceId: string,
	request: AccessRoleSetRequest,
): Promise<void> {
	await appDb.begin(async (tx) => {
		for (const role of request.roles) {
			await tx`
				INSERT INTO datasource_roles
					(workspace_id, connection_ref, role_name, untrusted, authenticator, shown)
				VALUES (${workspaceId}, ${request.connectionId}, ${role.name},
					${role.untrusted}, ${role.authenticator}, ${role.shown})
				ON CONFLICT (workspace_id, connection_ref, role_name) DO UPDATE SET
					untrusted = EXCLUDED.untrusted,
					authenticator = EXCLUDED.authenticator,
					shown = EXCLUDED.shown
			`;
		}
	});
	log.audit("access.roles.set", {
		workspaceId,
		connectionRef: request.connectionId,
		roles: request.roles.length,
	});
}

/** Domain names by `kind:schema.name`, for the report's grouping column. */
async function domainsByObject(
	appDb: AppDb,
	workspaceId: string,
	connectionRef: string,
): Promise<Map<string, string>> {
	const rows = await appDb<
		Array<{ schema: string; name: string; kind: string; domain: string }>
	>`
		SELECT t.schema, t.name, t.kind, d.name AS domain
		FROM domain_tags t
		JOIN domains d ON d.id = t.domain_id
		WHERE d.workspace_id = ${workspaceId} AND d.connection_ref = ${connectionRef}
	`;
	return new Map(
		rows.map((row) => [`${row.kind}:${row.schema}.${row.name}`, row.domain]),
	);
}

async function objectsInDomain(
	appDb: AppDb,
	workspaceId: string,
	connectionRef: string,
	domainId: string,
): Promise<Array<{ schema: string; name: string }>> {
	return appDb<Array<{ schema: string; name: string }>>`
		SELECT t.schema, t.name
		FROM domain_tags t
		JOIN domains d ON d.id = t.domain_id
		WHERE d.workspace_id = ${workspaceId}
			AND d.connection_ref = ${connectionRef}
			AND d.id = ${domainId}
	`;
}

export interface ReportBundle {
	result: AccessReportResult;
	/** The raw adapter data, for the export's markdown. */
	data: AccessReportData;
	findings: Finding[];
	untrusted: string[];
}

export async function buildReport(
	appDb: AppDb,
	connections: ConnectionsService,
	workspace: WorkspaceRef,
	request: AccessReportRequest,
	maxCells: number,
): Promise<ReportBundle> {
	const stored = await storedRoles(appDb, workspace.id, request.connectionId);
	const authenticator =
		[...stored.values()].find((row) => row.authenticator)?.role_name ?? null;
	const discovered = await connections.readRoles(
		workspace,
		request.connectionId,
		authenticator,
	);
	const shown = discovered.roles
		.filter((role) => {
			const row = stored.get(role.name);
			return row?.shown ?? (!role.superuser && role.name !== "postgres");
		})
		.map((role) => role.name);
	// Marking an authenticator expands the columns to every role a request
	// can arrive as, which is the set PostgREST actually uses.
	const roles = [
		...new Set([...shown, ...discovered.authenticatorReach]),
	].sort();
	const untrusted = new Set(
		[...stored.values()]
			.filter((row) => row.untrusted)
			.map((row) => row.role_name),
	);

	const domains = await domainsByObject(
		appDb,
		workspace.id,
		request.connectionId,
	);
	const only =
		request.domainId === undefined
			? []
			: await objectsInDomain(
					appDb,
					workspace.id,
					request.connectionId,
					request.domainId,
				);

	const data = await connections.readAccessReport(
		workspace,
		request.connectionId,
		{
			schemas: request.schemas,
			roles,
			domains,
			only,
			maxCells,
			countOnly: request.countOnly,
		},
	);

	const findings = request.countOnly
		? []
		: findingsFor(request.connectionId, data, untrusted);

	return {
		result: {
			roles,
			objects: data.objects,
			schemaUsage: data.schemaUsage,
			defaultAcl: data.defaultAcl,
			policies: data.policies,
			columnGrants: data.columnGrants,
			cellCount: data.cellCount,
			countOnly: request.countOnly,
		},
		data,
		findings,
		untrusted: [...untrusted].sort(),
	};
}

/**
 * Which base relations a view exposes to a role that cannot read them
 * directly. Answering `null` rather than `[]` when the dependency read
 * produced nothing matters: `grant.view-owner-bypass` treats null as
 * "not asked" and stays silent, which is the difference between a rule
 * that knows and a rule that guesses.
 */
function viewBypassFor(
	object: AccessObject,
	data: AccessReportData,
	untrusted: Set<string>,
	reachIndex: Map<string, Map<string, string[]>>,
): Array<{ role: string; relation: string }> | null {
	if (object.kind !== "view" || object.securityInvoker !== false) {
		return null;
	}
	const bases = data.viewDependencies.get(`${object.schema}.${object.name}`);
	if (bases === undefined) {
		return null;
	}
	const exposed: Array<{ role: string; relation: string }> = [];
	for (const cell of object.cells) {
		if (
			!untrusted.has(cell.role) ||
			cell.schemaBlocked ||
			!cell.privileges.includes("select")
		) {
			continue;
		}
		for (const base of bases) {
			const baseReach = reachIndex.get(base)?.get(cell.role);
			// Unknown base relation: it was filtered out of this report, so we
			// cannot say whether the role reaches it. Not a finding.
			if (baseReach === undefined) {
				continue;
			}
			if (!baseReach.includes("select")) {
				exposed.push({ role: cell.role, relation: base });
			}
		}
	}
	return exposed;
}

function untrustedDefaultAcl(
	defaultAcl: DefaultAclEntry[],
	untrusted: Set<string>,
): Array<{ grantee: string; objectType: string }> {
	return defaultAcl
		.filter(
			(entry) => untrusted.has(entry.grantee) || entry.grantee === "PUBLIC",
		)
		.map((entry) => ({ grantee: entry.grantee, objectType: entry.objectType }));
}

/**
 * Run the `grant.*` rules over a report. The datasource-scoped rule is
 * evaluated once rather than once per object, or a database with two
 * hundred tables would report the same default-privileges problem two
 * hundred times.
 */
export function findingsFor(
	connectionId: string,
	data: AccessReportData,
	untrusted: Set<string>,
): Finding[] {
	const reachIndex = new Map<string, Map<string, string[]>>();
	for (const object of data.objects) {
		const byRole = new Map<string, string[]>();
		for (const cell of object.cells) {
			byRole.set(cell.role, cell.schemaBlocked ? [] : cell.privileges);
		}
		reachIndex.set(`${object.schema}.${object.name}`, byRole);
	}

	const findings: Finding[] = [];
	for (const object of data.objects) {
		const input: AccessInput = {
			connectionId,
			schema: object.schema,
			name: object.name,
			kind: object.kind,
			owner: object.owner,
			rls: object.rls,
			policyCount: object.policyCount,
			securityInvoker: object.securityInvoker,
			securityDefiner: object.securityDefiner,
			searchPathPinned: object.searchPathPinned,
			reach: object.cells.map((cell) => ({
				role: cell.role,
				untrusted: untrusted.has(cell.role),
				privileges: cell.privileges,
				blocked: cell.schemaBlocked,
			})),
			viewBypass: viewBypassFor(object, data, untrusted, reachIndex),
			// Empty here: the datasource-scoped rule runs once, below.
			defaultAclUntrusted: [],
		};
		findings.push(...runRules(RULES, { access: input }).findings);
	}

	const defaultAclUntrusted = untrustedDefaultAcl(data.defaultAcl, untrusted);
	if (defaultAclUntrusted.length > 0) {
		// Once for the datasource, not once per object: two hundred tables
		// must not report the same default-privileges problem two hundred
		// times. The filter keeps that true if a future rule starts firing
		// on this deliberately empty object.
		findings.push(
			...runRules(RULES, {
				access: {
					connectionId,
					schema: "",
					name: "",
					kind: "table",
					owner: "",
					rls: "none",
					policyCount: 0,
					securityInvoker: null,
					securityDefiner: null,
					searchPathPinned: null,
					reach: [],
					viewBypass: null,
					defaultAclUntrusted,
				},
			}).findings.filter((finding) => finding.at.kind === "datasource"),
		);
	}
	return findings;
}
