import type { Finding } from "@datagripe/contracts";
import { type AccessInput, accessLocation, type Rule } from "../types";

/**
 * The `grant.*` rules (docs/spec/access-report.md "Findings, not
 * opinions in the margin").
 *
 * These are gripes rather than a second, parallel notion of "warning":
 * they run in the same engine, get dismissed at the same three scopes,
 * and appear in the gripes panel as well as in the access report.
 *
 * Every rule below reads *effective* reach — `has_*_privilege` already
 * resolved PUBLIC, inheritance and superuser, and `blocked` records that
 * the role cannot enter the schema. None of them re-derives access from
 * an ACL, because that is exactly the mistake the report exists to fix.
 *
 * A rule with nothing to read stays silent. In particular: with no role
 * marked untrusted, every rule here returns nothing rather than guessing
 * which role is the PostgREST anonymous one.
 */

function untrustedReach(access: AccessInput) {
	return access.reach.filter((entry) => entry.untrusted && !entry.blocked);
}

function isRoutine(access: AccessInput): boolean {
	return access.kind === "function" || access.kind === "procedure";
}

/**
 * `grant.public-execute` — a routine `PUBLIC` can execute, in a schema an
 * untrusted role can enter.
 *
 * The loudest rule in the catalogue, and the only one whose subject is
 * the *default state* of a new object rather than a decision somebody
 * made. PostgreSQL grants `EXECUTE` on every new function to `PUBLIC`;
 * under PostgREST that is a live endpoint until someone revokes it.
 */
export const grantPublicExecute: Rule = {
	id: "grant.public-execute",
	severity: "blocker",
	inputs: ["access"],

	evaluate(context) {
		const access = context.access;
		if (access === undefined || !isRoutine(access)) {
			return [];
		}
		const exposed = untrustedReach(access).filter((entry) =>
			entry.privileges.includes("execute"),
		);
		if (exposed.length === 0) {
			return [];
		}
		return [
			{
				ruleId: grantPublicExecute.id,
				severity: grantPublicExecute.severity,
				at: accessLocation(access),
				facts: {
					routine: access.name,
					role: exposed.map((entry) => entry.role).join(", "),
				},
			},
		];
	},
};

/**
 * `grant.definer-public-reach` — `SECURITY DEFINER` **and** reachable by
 * an untrusted role.
 *
 * Strictly worse than either half alone: the routine runs with the
 * owner's privileges, and anonymous callers can start it.
 * `routine.definer-no-search-path` is about a different failure (name
 * resolution) and both can fire on the same routine, which is correct —
 * they are two separate problems.
 */
export const grantDefinerPublicReach: Rule = {
	id: "grant.definer-public-reach",
	severity: "blocker",
	inputs: ["access"],

	evaluate(context) {
		const access = context.access;
		if (
			access === undefined ||
			!isRoutine(access) ||
			access.securityDefiner !== true
		) {
			return [];
		}
		const exposed = untrustedReach(access).filter((entry) =>
			entry.privileges.includes("execute"),
		);
		if (exposed.length === 0) {
			return [];
		}
		return [
			{
				ruleId: grantDefinerPublicReach.id,
				severity: grantDefinerPublicReach.severity,
				at: accessLocation(access),
				facts: {
					routine: access.name,
					owner: access.owner,
					role: exposed.map((entry) => entry.role).join(", "),
				},
			},
		];
	},
};

const WRITE_PRIVILEGES = ["insert", "update", "delete"];

/** `grant.untrusted-write` — an untrusted role can write to a relation. */
export const grantUntrustedWrite: Rule = {
	id: "grant.untrusted-write",
	severity: "blocker",
	inputs: ["access"],

	evaluate(context) {
		const access = context.access;
		if (access === undefined || isRoutine(access)) {
			return [];
		}
		const findings: Finding[] = [];
		for (const entry of untrustedReach(access)) {
			const writes = WRITE_PRIVILEGES.filter((privilege) =>
				entry.privileges.includes(privilege),
			);
			if (writes.length === 0) {
				continue;
			}
			findings.push({
				ruleId: grantUntrustedWrite.id,
				severity: grantUntrustedWrite.severity,
				at: accessLocation(access),
				facts: {
					relation: `${access.schema}.${access.name}`,
					role: entry.role,
					privileges: writes.join(", "),
				},
			});
		}
		return findings;
	},
};

/**
 * `grant.untrusted-read-no-rls` — an untrusted role can `SELECT` a table
 * with row-level security off, so it reads every row.
 *
 * Only tables: a view has no RLS of its own, and complaining about one
 * would double-count the base table's finding.
 */
export const grantUntrustedReadNoRls: Rule = {
	id: "grant.untrusted-read-no-rls",
	severity: "warning",
	inputs: ["access"],

	evaluate(context) {
		const access = context.access;
		if (access === undefined || access.rls !== "off") {
			return [];
		}
		const readers = untrustedReach(access).filter((entry) =>
			entry.privileges.includes("select"),
		);
		if (readers.length === 0) {
			return [];
		}
		return [
			{
				ruleId: grantUntrustedReadNoRls.id,
				severity: grantUntrustedReadNoRls.severity,
				at: accessLocation(access),
				facts: {
					relation: `${access.schema}.${access.name}`,
					role: readers.map((entry) => entry.role).join(", "),
				},
			},
		];
	},
};

/**
 * `grant.rls-no-policy` — row-level security on, zero policies.
 *
 * Denies every row to every non-owner, and fails as an empty result set
 * rather than as an error. Usually a mistake in the opposite direction
 * from the rest of this file, which is why it is here rather than
 * assumed safe.
 */
export const grantRlsNoPolicy: Rule = {
	id: "grant.rls-no-policy",
	severity: "warning",
	inputs: ["access"],

	evaluate(context) {
		const access = context.access;
		if (access === undefined) {
			return [];
		}
		if (
			(access.rls !== "on" && access.rls !== "forced") ||
			access.policyCount > 0
		) {
			return [];
		}
		return [
			{
				ruleId: grantRlsNoPolicy.id,
				severity: grantRlsNoPolicy.severity,
				at: accessLocation(access),
				facts: { relation: `${access.schema}.${access.name}` },
			},
		];
	},
};

/**
 * `grant.view-owner-bypass` — a view without `security_invoker` reads its
 * base relations as its owner, so granting it to a role hands over data
 * that role cannot read directly.
 *
 * A deliberate pattern *and* a common accident, so this marks it and
 * lets a person decide which. `viewBypass === null` means the question
 * was not asked, and the rule stays silent rather than guessing.
 */
export const grantViewOwnerBypass: Rule = {
	id: "grant.view-owner-bypass",
	severity: "warning",
	inputs: ["access"],

	evaluate(context) {
		const access = context.access;
		if (
			access === undefined ||
			access.kind !== "view" ||
			access.securityInvoker !== false ||
			access.viewBypass === null ||
			access.viewBypass.length === 0
		) {
			return [];
		}
		const first = access.viewBypass[0];
		if (first === undefined) {
			return [];
		}
		return [
			{
				ruleId: grantViewOwnerBypass.id,
				severity: grantViewOwnerBypass.severity,
				at: accessLocation(access),
				facts: {
					view: `${access.schema}.${access.name}`,
					relation: first.relation,
					role: first.role,
					owner: access.owner,
				},
			},
		];
	},
};

/**
 * `grant.default-privileges-untrusted` — `ALTER DEFAULT PRIVILEGES` will
 * grant future objects to an untrusted role.
 *
 * Datasource-scoped rather than object-scoped: it is true before any
 * object exists to point at, which is exactly what makes it worth
 * catching.
 */
export const grantDefaultPrivilegesUntrusted: Rule = {
	id: "grant.default-privileges-untrusted",
	severity: "blocker",
	inputs: ["access"],

	evaluate(context) {
		const access = context.access;
		if (access === undefined || access.defaultAclUntrusted.length === 0) {
			return [];
		}
		const first = access.defaultAclUntrusted[0];
		if (first === undefined) {
			return [];
		}
		return [
			{
				ruleId: grantDefaultPrivilegesUntrusted.id,
				severity: grantDefaultPrivilegesUntrusted.severity,
				at: { kind: "datasource", connectionId: access.connectionId },
				facts: { role: first.grantee, objects: first.objectType },
			},
		];
	},
};

export const GRANT_RULES: Rule[] = [
	grantPublicExecute,
	grantDefinerPublicReach,
	grantUntrustedWrite,
	grantUntrustedReadNoRls,
	grantRlsNoPolicy,
	grantViewOwnerBypass,
	grantDefaultPrivilegesUntrusted,
];
