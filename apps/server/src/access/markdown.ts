import type {
	AccessCell,
	AccessObject,
	DefaultAclEntry,
	Dismissal,
	Finding,
	RlsPolicy,
} from "@datagripe/contracts";
import { GRIPE_SEVERITIES, isDismissed } from "@datagripe/contracts";
import { MESSAGES, renderFinding, renderFooter } from "@datagripe/gripes";

/**
 * The `access/` files in the domain dump (docs/spec/access-report.md
 * "Export").
 *
 * These replace the markdown a hand-written `permissions_matrix.sh`
 * produces, with one deliberate difference: **there is no
 * `Generated: <date>` line.** The scripts write one, so every run
 * dirties both files and the diff that would have told you `anon` gained
 * `UPDATE` last Tuesday is buried under a date change. The timestamp
 * belongs in the run history and in `pull.log`, not in the artifact
 * being diffed.
 *
 * Everything else follows from the same rule: fixed ordering, no sizes,
 * no row counts, no server version.
 */

const PRIVILEGE_LETTERS: Record<string, string> = {
	select: "R",
	insert: "C",
	update: "U",
	delete: "D",
	execute: "X",
	usage: "G",
};

/** Escape a value for a markdown table cell. */
function cell(value: string): string {
	return value.replaceAll("|", "\\|").replaceAll("\n", " ");
}

/**
 * A cell's letters, with the marker that carries the whole point of the
 * report: `°` means reachable without a direct grant to this role.
 * `~R~` means the role has no `USAGE` on the schema, so the privilege is
 * inert — struck rather than hidden, because "granted but unreachable"
 * and "not granted" are different facts.
 */
export function renderCell(entry: AccessCell): string {
	if (entry.privileges.length === 0) {
		return "–";
	}
	const letters = entry.privileges
		.map((privilege) => PRIVILEGE_LETTERS[privilege] ?? privilege)
		.join("");
	if (entry.schemaBlocked) {
		return `~~${letters}~~`;
	}
	const indirect = entry.path !== null && !entry.sources.includes("direct");
	return indirect ? `${letters}°` : letters;
}

function cellsFor(object: AccessObject, roles: string[]): AccessCell[] {
	const byRole = new Map(object.cells.map((entry) => [entry.role, entry]));
	return roles.map(
		(role) =>
			byRole.get(role) ?? {
				role,
				privileges: [],
				sources: [],
				path: null,
				schemaBlocked: false,
			},
	);
}

function isRoutine(object: AccessObject): boolean {
	return object.kind === "function" || object.kind === "procedure";
}

export function renderMatrix(roles: string[], objects: AccessObject[]): string {
	const relations = objects.filter((object) => !isRoutine(object));
	const routines = objects.filter(isRoutine);
	const lines: string[] = [
		"# Permissions matrix",
		"",
		"Effective privileges. Every cell is what the role can actually do:",
		"`has_table_privilege` and `has_function_privilege` answers, so grants",
		"to `PUBLIC`, grants inherited through a role, and ownership are already",
		"resolved. A direct-grant scan would miss all three.",
		"",
		"## Legend",
		"",
		"- `R` select · `C` insert · `U` update · `D` delete · `X` execute",
		"- `°` reachable **without** a direct grant to that role — see Paths",
		"- `~~R~~` the role has no `USAGE` on the schema, so the privilege is inert",
		"- `–` no access",
		"",
	];

	lines.push("## Tables and views", "");
	if (relations.length === 0) {
		lines.push("None.", "");
	} else {
		lines.push(
			`| Object | Domain | Type | ${roles.map(cell).join(" | ")} | RLS | Policies |`,
			`|---|---|---|${roles.map(() => "---").join("|")}|---|---|`,
		);
		for (const object of relations) {
			lines.push(
				`| ${cell(`${object.schema}.${object.name}`)} | ${
					object.domain ?? "–"
				} | ${object.kind} | ${cellsFor(object, roles)
					.map(renderCell)
					.join(" | ")} | ${object.rls} | ${object.policyCount} |`,
			);
		}
		lines.push("");
	}

	lines.push("## Routines", "");
	if (routines.length === 0) {
		lines.push("None.", "");
	} else {
		lines.push(
			`| Routine | Domain | ${roles.map(cell).join(" | ")} | Definer | search_path |`,
			`|---|---|${roles.map(() => "---").join("|")}|---|---|`,
		);
		for (const object of routines) {
			lines.push(
				`| ${cell(`${object.schema}.${object.name}`)} | ${
					object.domain ?? "–"
				} | ${cellsFor(object, roles)
					.map(renderCell)
					.join(" | ")} | ${object.securityDefiner === true ? "yes" : "no"} | ${
					object.searchPathPinned === true ? "pinned" : "–"
				} |`,
			);
		}
		lines.push("");
	}

	// Markdown has no hover, so the path that explains every `°` needs a
	// place to live. This section is the report's actual product: not
	// "anon can read this" but "anon can read this because somebody
	// granted it to PUBLIC".
	const paths: string[] = [];
	for (const object of objects) {
		for (const entry of cellsFor(object, roles)) {
			if (entry.path === null || entry.privileges.length === 0) {
				continue;
			}
			if (entry.sources.length === 1 && entry.sources[0] === "direct") {
				continue;
			}
			paths.push(
				`| ${cell(`${object.schema}.${object.name}`)} | ${cell(entry.role)} | ${cell(
					entry.path,
				)} |`,
			);
		}
	}
	lines.push("## Paths", "");
	if (paths.length === 0) {
		lines.push("Every privilege above was granted to its role by name.", "");
	} else {
		lines.push("| Object | Role | Path |", "|---|---|---|", ...paths, "");
	}

	return `${lines.join("\n").trimEnd()}\n`;
}

export function renderPolicies(policies: RlsPolicy[]): string {
	const lines: string[] = ["# RLS policies", ""];
	if (policies.length === 0) {
		lines.push(
			"No row-level security policies.",
			"",
			"That is not the same as no row-level security: a table with RLS",
			"enabled and zero policies denies every row. See the matrix.",
		);
		return `${lines.join("\n").trimEnd()}\n`;
	}
	for (const policy of policies) {
		lines.push(
			`## ${policy.schema}.${policy.table} — \`${policy.name}\``,
			"",
			`- Roles: ${policy.roles.join(", ")}`,
			`- Command: ${policy.command}`,
			"",
			"```sql",
			`-- USING`,
			policy.using ?? "true",
			"```",
			"",
		);
		if (policy.withCheck !== null) {
			lines.push("```sql", "-- WITH CHECK", policy.withCheck, "```", "");
		}
	}
	return `${lines.join("\n").trimEnd()}\n`;
}

export function renderDefaultAcl(entries: DefaultAclEntry[]): string {
	const lines: string[] = [
		"# Default privileges",
		"",
		"`ALTER DEFAULT PRIVILEGES` decides what the *next* object gets. An",
		"entry here is the difference between an audit you do once and an",
		"audit you do forever.",
		"",
	];
	if (entries.length === 0) {
		lines.push("No default privilege entries.");
		return `${lines.join("\n").trimEnd()}\n`;
	}
	lines.push(
		"| Created by | Schema | Object type | Grantee | Privileges |",
		"|---|---|---|---|---|",
	);
	for (const entry of entries) {
		lines.push(
			`| ${cell(entry.owner)} | ${cell(entry.schema ?? "(all)")} | ${cell(
				entry.objectType,
			)} | ${cell(entry.grantee)} | ${entry.privileges.join(", ")} |`,
		);
	}
	return `${lines.join("\n").trimEnd()}\n`;
}

/**
 * Findings, ordered by severity then object.
 *
 * Rendered at `notice` — the plain, profanity-free register. The export
 * is read in code review by people who did not choose an attitude level,
 * and a repository artifact is the wrong place to shout.
 *
 * Dismissed findings are listed in a trailing section rather than
 * omitted: a dismissal is a decision, and the repository should record
 * that somebody made it.
 */
export function renderFindings(
	findings: Finding[],
	dismissals: Dismissal[],
): string {
	const order = new Map(
		GRIPE_SEVERITIES.map((severity, index) => [severity, index]),
	);
	const place = (finding: Finding): string =>
		finding.at.kind === "object"
			? `${finding.at.schema}.${finding.at.name}`
			: finding.at.kind === "datasource"
				? "(datasource)"
				: "";
	const sorted = [...findings].sort(
		(a, b) =>
			(order.get(a.severity) ?? 99) - (order.get(b.severity) ?? 99) ||
			place(a).localeCompare(place(b)) ||
			a.ruleId.localeCompare(b.ruleId),
	);
	const live = sorted.filter((finding) => !isDismissed(finding, dismissals));
	const silenced = sorted.filter((finding) => isDismissed(finding, dismissals));

	const lines: string[] = ["# Access findings", ""];
	if (live.length === 0) {
		lines.push("Nothing to report.", "");
	} else {
		lines.push("| Severity | Object | Finding | Rule |", "|---|---|---|---|");
		for (const finding of live) {
			lines.push(
				`| ${finding.severity} | ${cell(place(finding))} | ${cell(
					renderFinding(finding, "notice", MESSAGES),
				)} | \`${finding.ruleId}\` |`,
			);
		}
		lines.push("");
	}

	if (silenced.length > 0) {
		lines.push(
			"## Dismissed",
			"",
			"Still true; somebody decided they were acceptable.",
			"",
			"| Severity | Object | Finding | Rule |",
			"|---|---|---|---|",
		);
		for (const finding of silenced) {
			lines.push(
				`| ${finding.severity} | ${cell(place(finding))} | ${cell(
					renderFinding(finding, "notice", MESSAGES),
				)} | \`${finding.ruleId}\` |`,
			);
		}
		lines.push("");
	}

	lines.push("---", "", ...live.map((finding) => `- ${renderFooter(finding)}`));
	return `${lines.join("\n").trimEnd()}\n`;
}
