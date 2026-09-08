import type {
	AccessCell,
	AccessObject,
	AccessSource,
	ColumnGrant,
	DatasourceRole,
	DefaultAclEntry,
	Privilege,
	RlsPolicy,
	RlsState,
	SchemaUsage,
} from "@datagripe/contracts";
import type { SQL } from "bun";
import type { TableLimits } from "../types";

/**
 * PostgreSQL access report (docs/spec/access-report.md).
 *
 * The one thing this file exists to get right: **effective privileges
 * come from `has_*_privilege`, never from an ACL scan.** Those functions
 * resolve `PUBLIC`, role inheritance (respecting `NOINHERIT`) and
 * superuser inside the server, which is the only place that logic is
 * correct. The ACL scan below runs alongside them purely to *explain* an
 * answer — `via PUBLIC`, `via member of authenticated`, `owner`.
 *
 * `information_schema.role_table_grants`, which the object view's grants
 * tab uses, cannot do this job: it reports direct grants only, so a
 * `GRANT ... TO PUBLIC` appears once as grantee `PUBLIC` and a grant
 * inherited through a role appears against the parent's name. Scan
 * either for `anon` and you find nothing while `anon` has the privilege.
 *
 * The second thing: **a NULL ACL is not "no grants".** `relacl IS NULL`
 * means the owner has everything; `proacl IS NULL` means the owner has
 * everything *and so does PUBLIC*, because PostgreSQL grants `EXECUTE`
 * on every new routine to `PUBLIC` by default. Under PostgREST that is
 * a public endpoint nobody chose. It is handled explicitly rather than
 * through `acldefault()`, whose object-type characters have moved
 * between versions.
 */

type Row = Record<string, unknown>;
type Bound = (sql: string, params: unknown[]) => Promise<Row[]>;

const PRIVILEGE_NAMES = [
	"select",
	"insert",
	"update",
	"delete",
	"execute",
	"usage",
];

function str(value: unknown, fallback = ""): string {
	return typeof value === "string" ? value : fallback;
}

function bool(value: unknown): boolean {
	return value === true;
}

function strings(value: unknown): string[] {
	return Array.isArray(value) ? value.filter((v) => typeof v === "string") : [];
}

/**
 * A PostgreSQL array literal for a `text[]` parameter.
 *
 * Bun's SQL sends a JS array as its own default rendering, which the
 * server rejects with "malformed array literal". Building the literal
 * here keeps the queries parameterised — the values still travel as one
 * bound parameter, never interpolated into the statement.
 */
export function toPgTextArray(values: string[]): string {
	if (values.length === 0) {
		return "{}";
	}
	const quoted = values.map(
		(value) => `"${value.replaceAll("\\", "\\\\").replaceAll('"', '\\"')}"`,
	);
	return `{${quoted.join(",")}}`;
}

function privileges(value: unknown): Privilege[] {
	return strings(value).filter((p): p is Privilege =>
		PRIVILEGE_NAMES.includes(p),
	);
}

/**
 * Objects belonging to an extension are not the user's to audit and
 * would bury the report. `pg_depend` with `deptype = 'e'` is the correct
 * test, and it replaces the hand-maintained name regexes these reports
 * are usually built with (`proname !~ '^(gbt_|armor|pgp_|...)'`), which
 * go stale the moment an extension is added.
 */
const NOT_EXTENSION_OWNED = `
	NOT EXISTS (
		SELECT 1 FROM pg_depend d
		WHERE d.objid = c.oid AND d.deptype = 'e'
	)`;

const SCHEMA_FILTER = `
	n.nspname NOT LIKE 'pg\\_%'
	AND n.nspname <> 'information_schema'
	AND (cardinality($1::text[]) = 0 OR n.nspname = ANY($1::text[]))`;

const ROLES_SQL = `
	SELECT r.rolname AS name,
		r.rolcanlogin AS can_login,
		r.rolsuper AS superuser,
		r.rolbypassrls AS bypass_rls,
		r.rolinherit AS inherit,
		COALESCE(
			(SELECT array_agg(g.rolname ORDER BY g.rolname)
			 FROM pg_auth_members m
			 JOIN pg_roles g ON g.oid = m.roleid
			 WHERE m.member = r.oid),
			ARRAY[]::name[]
		)::text[] AS member_of
	FROM pg_roles r
	WHERE r.rolname NOT LIKE 'pg\\_%'
	ORDER BY r.rolname`;

/**
 * Roles the authenticator can become, transitively — under PostgREST
 * exactly the identities a request can arrive as.
 *
 * `'MEMBER'` rather than `'USAGE'` on purpose: `SET ROLE` works across a
 * `NOINHERIT` membership, where privilege inheritance does not. Using
 * `'USAGE'` here would under-report the reachable set, which is the
 * unsafe direction to be wrong in.
 */
const AUTHENTICATOR_REACH_SQL = `
	SELECT r.rolname AS name
	FROM pg_roles r
	WHERE r.rolname NOT LIKE 'pg\\_%'
		AND r.rolname <> $1
		AND pg_has_role($1, r.oid, 'MEMBER')
	ORDER BY r.rolname`;

export type DiscoveredRole = Pick<
	DatasourceRole,
	"name" | "canLogin" | "superuser" | "bypassRls" | "inherit" | "memberOf"
>;

export async function readPostgresRoles(
	client: SQL,
	limits: TableLimits,
	authenticator: string | null,
): Promise<{ roles: DiscoveredRole[]; authenticatorReach: string[] }> {
	const reserved = await client.reserve();
	try {
		await reserved.unsafe(
			`SET statement_timeout = ${Math.max(1, Math.floor(limits.timeoutMs))}`,
		);
		await reserved.unsafe("BEGIN READ ONLY");
		try {
			const roleRows = (await reserved.unsafe(ROLES_SQL, [])) as Row[];
			const reachRows =
				authenticator === null
					? []
					: ((await reserved.unsafe(AUTHENTICATOR_REACH_SQL, [
							authenticator,
						])) as Row[]);
			return {
				roles: roleRows.map((row) => ({
					name: str(row.name),
					canLogin: bool(row.can_login),
					superuser: bool(row.superuser),
					bypassRls: bool(row.bypass_rls),
					inherit: bool(row.inherit),
					memberOf: strings(row.member_of),
				})),
				authenticatorReach: reachRows.map((row) => str(row.name)),
			};
		} finally {
			await reserved.unsafe("ROLLBACK").catch(() => {});
		}
	} finally {
		reserved.release();
	}
}

export interface AccessReportQuery {
	/** Empty means every non-system schema. */
	schemas: string[];
	/** Column order, as selected. */
	roles: string[];
	/** `kind:schema.name` to domain name, for the grouping column. */
	domains: Map<string, string>;
	/** Restrict to these objects (the domain filter); empty means no filter. */
	only: Array<{ schema: string; name: string }>;
	maxCells: number;
	countOnly: boolean;
}

export interface AccessReportData {
	objects: AccessObject[];
	schemaUsage: SchemaUsage[];
	defaultAcl: DefaultAclEntry[];
	policies: RlsPolicy[];
	columnGrants: Array<{ schema: string; name: string; grants: ColumnGrant[] }>;
	/** `schema.view` to the base relations it reads. */
	viewDependencies: Map<string, string[]>;
	cellCount: number;
}

export class AccessReportTooLargeError extends Error {
	readonly cellCount: number;

	constructor(cellCount: number, maxCells: number) {
		super(
			`This report is ${cellCount} cells, over the ${maxCells} limit — filter by schema or domain`,
		);
		this.name = "AccessReportTooLargeError";
		this.cellCount = cellCount;
	}
}

/**
 * Relations, with each selected role's effective privileges.
 *
 * `has_table_privilege` per role per privilege gives the answer; the ACL
 * scan in the same row explains it. When `relacl IS NULL` the scan
 * contributes nothing, which is right — the owner accounts for it, and
 * no other role has anything.
 */
const RELATIONS_SQL = `
	SELECT n.nspname AS schema,
		c.relname AS name,
		CASE c.relkind WHEN 'v' THEN 'view' WHEN 'm' THEN 'view' ELSE 'table' END AS kind,
		c.relkind::text AS relkind,
		pg_get_userbyid(c.relowner) AS owner,
		c.relrowsecurity AS rls_enabled,
		c.relforcerowsecurity AS rls_forced,
		(SELECT count(*)::int FROM pg_policy p WHERE p.polrelid = c.oid) AS policy_count,
		COALESCE(array_to_string(c.reloptions, ',') ~* 'security_invoker=(on|true)', false)
			AS security_invoker,
		EXISTS (
			SELECT 1 FROM pg_attribute a
			WHERE a.attrelid = c.oid AND a.attnum > 0 AND a.attacl IS NOT NULL
		) AS has_column_grants,
		(
			SELECT jsonb_agg(jsonb_build_object(
				'role', cells.role_name,
				'privileges', cells.privs,
				'direct', cells.direct_privs,
				'public', cells.public_privs,
				'via_role', cells.via_role,
				'owner', cells.is_owner,
				'superuser', cells.is_super,
				'schema_blocked', cells.schema_blocked
			) ORDER BY cells.ord)
			FROM (
				SELECT r.role_name, r.ord,
					ARRAY(
						SELECT p FROM unnest(ARRAY['select','insert','update','delete']) AS p
						WHERE has_table_privilege(r.role_name, c.oid, p)
					) AS privs,
					ARRAY(
						SELECT p FROM unnest(ARRAY['select','insert','update','delete']) AS p
						WHERE EXISTS (
							SELECT 1 FROM aclexplode(c.relacl) a
							WHERE a.grantee = ro.oid AND lower(a.privilege_type) = p
						)
					) AS direct_privs,
					ARRAY(
						SELECT p FROM unnest(ARRAY['select','insert','update','delete']) AS p
						WHERE EXISTS (
							SELECT 1 FROM aclexplode(c.relacl) a
							WHERE a.grantee = 0 AND lower(a.privilege_type) = p
						)
					) AS public_privs,
					(
						SELECT string_agg(DISTINCT g.rolname, ', ' ORDER BY g.rolname)
						FROM aclexplode(c.relacl) a
						JOIN pg_roles g ON g.oid = a.grantee
						WHERE a.grantee <> 0
							AND a.grantee <> ro.oid
							AND pg_has_role(r.role_name, a.grantee, 'USAGE')
					) AS via_role,
					c.relowner = ro.oid AS is_owner,
					ro.rolsuper AS is_super,
					NOT has_schema_privilege(r.role_name, n.oid, 'USAGE') AS schema_blocked
				FROM unnest($2::text[]) WITH ORDINALITY AS r(role_name, ord)
				JOIN pg_roles ro ON ro.rolname = r.role_name
			) AS cells
		) AS cells
	FROM pg_class c
	JOIN pg_namespace n ON n.oid = c.relnamespace
	WHERE c.relkind IN ('r', 'v', 'm', 'p')
		AND ${SCHEMA_FILTER}
		AND ${NOT_EXTENSION_OWNED}
	ORDER BY n.nspname, c.relname`;

/**
 * Routines. `proacl IS NULL` is the reason this report exists: it means
 * the owner has everything and `PUBLIC` has `EXECUTE`, because that is
 * PostgreSQL's default for every new function. `public_execute` says so
 * explicitly rather than reporting an empty grant list, which is what a
 * naive ACL scan does and what makes it dangerous.
 */
const ROUTINES_SQL = `
	SELECT n.nspname AS schema,
		p.proname || '(' || pg_get_function_identity_arguments(p.oid) || ')' AS name,
		CASE p.prokind WHEN 'p' THEN 'procedure' ELSE 'function' END AS kind,
		pg_get_userbyid(p.proowner) AS owner,
		p.prosecdef AS security_definer,
		EXISTS (
			SELECT 1 FROM unnest(COALESCE(p.proconfig, ARRAY[]::text[])) AS cfg
			WHERE cfg ILIKE 'search\\_path=%'
		) AS search_path_pinned,
		(p.proacl IS NULL OR EXISTS (
			SELECT 1 FROM aclexplode(p.proacl) a
			WHERE a.grantee = 0 AND a.privilege_type = 'EXECUTE'
		)) AS public_execute,
		(
			SELECT jsonb_agg(jsonb_build_object(
				'role', r.role_name,
				'privileges', CASE WHEN has_function_privilege(r.role_name, p.oid, 'EXECUTE')
					THEN ARRAY['execute'] ELSE ARRAY[]::text[] END,
				'direct', CASE WHEN EXISTS (
						SELECT 1 FROM aclexplode(p.proacl) a
						WHERE a.grantee = ro.oid AND a.privilege_type = 'EXECUTE'
					) THEN ARRAY['execute'] ELSE ARRAY[]::text[] END,
				'public', CASE WHEN p.proacl IS NULL OR EXISTS (
						SELECT 1 FROM aclexplode(p.proacl) a
						WHERE a.grantee = 0 AND a.privilege_type = 'EXECUTE'
					) THEN ARRAY['execute'] ELSE ARRAY[]::text[] END,
				'via_role', (
					SELECT string_agg(DISTINCT g.rolname, ', ' ORDER BY g.rolname)
					FROM aclexplode(p.proacl) a
					JOIN pg_roles g ON g.oid = a.grantee
					WHERE a.grantee <> 0
						AND a.grantee <> ro.oid
						AND a.privilege_type = 'EXECUTE'
						AND pg_has_role(r.role_name, a.grantee, 'USAGE')
				),
				'owner', p.proowner = ro.oid,
				'superuser', ro.rolsuper,
				'schema_blocked', NOT has_schema_privilege(r.role_name, n.oid, 'USAGE')
			) ORDER BY r.ord)
			FROM unnest($2::text[]) WITH ORDINALITY AS r(role_name, ord)
			JOIN pg_roles ro ON ro.rolname = r.role_name
		) AS cells
	FROM pg_proc p
	JOIN pg_namespace n ON n.oid = p.pronamespace
	WHERE p.prokind IN ('f', 'p')
		AND n.nspname NOT LIKE 'pg\\_%'
		AND n.nspname <> 'information_schema'
		AND (cardinality($1::text[]) = 0 OR n.nspname = ANY($1::text[]))
		AND NOT EXISTS (
			SELECT 1 FROM pg_depend d
			WHERE d.objid = p.oid AND d.deptype = 'e'
		)
	ORDER BY n.nspname, 2`;

/**
 * Schema `USAGE` gates every cell. A privilege on a table the role
 * cannot reach is not access, and reporting it as access is the easiest
 * way to make a security report wrong in the reassuring direction.
 */
const SCHEMA_USAGE_SQL = `
	SELECT n.nspname AS schema,
		ARRAY(
			SELECT role_name FROM unnest($2::text[]) AS r(role_name)
			WHERE has_schema_privilege(r.role_name, n.oid, 'USAGE')
		) AS roles
	FROM pg_namespace n
	WHERE n.nspname NOT LIKE 'pg\\_%'
		AND n.nspname <> 'information_schema'
		AND (cardinality($1::text[]) = 0 OR n.nspname = ANY($1::text[]))
	ORDER BY n.nspname`;

/** What the *next* object gets — an audit you do once rather than forever. */
const DEFAULT_ACL_SQL = `
	SELECT pg_get_userbyid(d.defaclrole) AS owner,
		n.nspname AS schema,
		CASE d.defaclobjtype
			WHEN 'r' THEN 'tables' WHEN 'S' THEN 'sequences'
			WHEN 'f' THEN 'routines' WHEN 'T' THEN 'types'
			WHEN 'n' THEN 'schemas' ELSE d.defaclobjtype::text
		END AS object_type,
		CASE WHEN a.grantee = 0 THEN 'PUBLIC'
			ELSE COALESCE(pg_get_userbyid(a.grantee), 'unknown') END AS grantee,
		array_agg(DISTINCT lower(a.privilege_type)) AS privileges
	FROM pg_default_acl d
	LEFT JOIN pg_namespace n ON n.oid = d.defaclnamespace
	CROSS JOIN LATERAL aclexplode(d.defaclacl) a
	GROUP BY 1, 2, 3, 4
	ORDER BY 1, 2, 3, 4`;

const POLICIES_SQL = `
	SELECT schemaname AS schema, tablename AS table_name, policyname AS name,
		COALESCE(roles::text[], ARRAY['PUBLIC']) AS roles,
		cmd AS command, qual AS using_expr, with_check AS with_check
	FROM pg_policies
	WHERE schemaname NOT LIKE 'pg\\_%'
		AND (cardinality($1::text[]) = 0 OR schemaname = ANY($1::text[]))
	ORDER BY schemaname, tablename, policyname`;

/**
 * Column-level grants for the relations that have any. The object-level
 * cell necessarily rounds these off, so the expanded row comes from
 * `has_column_privilege` for the same reason the object row comes from
 * `has_table_privilege`.
 */
const COLUMN_GRANTS_SQL = `
	SELECT n.nspname AS schema, c.relname AS name,
		a.attname AS column_name, r.role_name,
		ARRAY(
			SELECT p FROM unnest(ARRAY['select','insert','update','references']) AS p
			WHERE has_column_privilege(r.role_name, c.oid, a.attnum, p)
		) AS privileges
	FROM pg_class c
	JOIN pg_namespace n ON n.oid = c.relnamespace
	JOIN pg_attribute a ON a.attrelid = c.oid AND a.attnum > 0 AND NOT a.attisdropped
	CROSS JOIN unnest($2::text[]) AS r(role_name)
	WHERE c.relkind IN ('r', 'v', 'm', 'p')
		AND a.attacl IS NOT NULL
		AND ${SCHEMA_FILTER}
	ORDER BY 1, 2, 3, 4`;

/**
 * Base relations each view reads, so `grant.view-owner-bypass` can ask
 * whether a grantee reaches data through the view that it cannot reach
 * directly. `pg_rewrite` + `pg_depend` is the only honest source: the
 * view definition text would need parsing, and parsing SQL to answer a
 * security question is how you get a wrong answer confidently.
 */
const VIEW_DEPENDENCIES_SQL = `
	SELECT vn.nspname AS view_schema, v.relname AS view_name,
		dn.nspname AS dep_schema, dep.relname AS dep_name
	FROM pg_rewrite rw
	JOIN pg_class v ON v.oid = rw.ev_class
	JOIN pg_namespace vn ON vn.oid = v.relnamespace
	JOIN pg_depend d ON d.objid = rw.oid AND d.classid = 'pg_rewrite'::regclass
	JOIN pg_class dep ON dep.oid = d.refobjid AND dep.relkind IN ('r', 'v', 'm', 'p')
	JOIN pg_namespace dn ON dn.oid = dep.relnamespace
	WHERE v.relkind IN ('v', 'm')
		AND dep.oid <> v.oid
		AND vn.nspname NOT LIKE 'pg\\_%'
		AND vn.nspname <> 'information_schema'
		AND (cardinality($1::text[]) = 0 OR vn.nspname = ANY($1::text[]))
	GROUP BY 1, 2, 3, 4
	ORDER BY 1, 2, 3, 4`;

const COUNT_SQL = `
	SELECT (
		(SELECT count(*) FROM pg_class c
			JOIN pg_namespace n ON n.oid = c.relnamespace
			WHERE c.relkind IN ('r','v','m','p') AND ${SCHEMA_FILTER}
				AND ${NOT_EXTENSION_OWNED}) * 4
		+ (SELECT count(*) FROM pg_proc p
			JOIN pg_namespace n ON n.oid = p.pronamespace
			WHERE p.prokind IN ('f','p') AND ${SCHEMA_FILTER})
	)::bigint * GREATEST(cardinality($2::text[]), 1) AS cells`;

type CellJson = {
	role?: unknown;
	privileges?: unknown;
	direct?: unknown;
	public?: unknown;
	via_role?: unknown;
	owner?: unknown;
	superuser?: unknown;
	schema_blocked?: unknown;
};

/**
 * One role's raw facts as a cell. `sources` is the explanation, and
 * `path` is the string rendered beside the marker — the whole product of
 * this report is that "anon can read this" becomes "anon can read this
 * because somebody granted it to PUBLIC three years ago".
 */
export function toCell(raw: CellJson): AccessCell {
	const effective = privileges(raw.privileges);
	const direct = strings(raw.direct);
	const publicPrivs = strings(raw.public);
	const viaRole = typeof raw.via_role === "string" ? raw.via_role : null;
	const isOwner = bool(raw.owner);
	const isSuper = bool(raw.superuser);

	const sources: AccessSource[] = [];
	const pathParts: string[] = [];
	if (direct.length > 0) {
		sources.push("direct");
	}
	if (publicPrivs.length > 0) {
		sources.push("public");
		pathParts.push("via PUBLIC");
	}
	if (viaRole !== null && viaRole !== "") {
		sources.push("role");
		pathParts.push(`via member of ${viaRole}`);
	}
	if (isOwner) {
		sources.push("owner");
		pathParts.push("owner");
	}
	if (isSuper) {
		sources.push("superuser");
		pathParts.push("superuser");
	}

	return {
		role: str(raw.role),
		privileges: effective,
		sources,
		// A cell whose every privilege was granted to this role by name
		// needs no explanation, so it gets no marker.
		path: pathParts.length === 0 ? null : pathParts.join(", "),
		schemaBlocked: bool(raw.schema_blocked),
	};
}

function cellsOf(value: unknown): AccessCell[] {
	if (!Array.isArray(value)) {
		return [];
	}
	return value.map((entry) => toCell((entry ?? {}) as CellJson));
}

export function rlsStateOf(row: {
	relkind?: unknown;
	rls_enabled?: unknown;
	rls_forced?: unknown;
}): RlsState {
	const relkind = str(row.relkind);
	if (relkind !== "r" && relkind !== "p") {
		return "none";
	}
	if (!bool(row.rls_enabled)) {
		return "off";
	}
	return bool(row.rls_forced) ? "forced" : "on";
}

export async function readPostgresAccessReport(
	client: SQL,
	limits: TableLimits,
	query: AccessReportQuery,
): Promise<AccessReportData> {
	const reserved = await client.reserve();
	try {
		await reserved.unsafe(
			`SET statement_timeout = ${Math.max(1, Math.floor(limits.timeoutMs))}`,
		);
		await reserved.unsafe("BEGIN READ ONLY");
		try {
			const bound: Bound = async (sql, params) =>
				(await reserved.unsafe(sql, params)) as Row[];
			const args = [toPgTextArray(query.schemas), toPgTextArray(query.roles)];

			// Count first. A report the caller cannot afford should cost one
			// cheap query rather than a statement timeout.
			const countRows = await bound(COUNT_SQL, args);
			const cellCount = Number(countRows[0]?.cells ?? 0);
			if (query.countOnly) {
				return {
					objects: [],
					schemaUsage: [],
					defaultAcl: [],
					policies: [],
					columnGrants: [],
					viewDependencies: new Map(),
					cellCount,
				};
			}
			if (cellCount > query.maxCells) {
				throw new AccessReportTooLargeError(cellCount, query.maxCells);
			}

			// Sequential, not Promise.all: one reserved backend runs one
			// statement at a time however many we dispatch.
			const relationRows = await bound(RELATIONS_SQL, args);
			const routineRows = await bound(ROUTINES_SQL, args);
			const usageRows = await bound(SCHEMA_USAGE_SQL, args);
			const defaultAclRows = await bound(DEFAULT_ACL_SQL, []);
			const policyRows = await bound(POLICIES_SQL, [
				toPgTextArray(query.schemas),
			]);
			const columnRows = await bound(COLUMN_GRANTS_SQL, args);
			const viewDepRows = await bound(VIEW_DEPENDENCIES_SQL, [
				toPgTextArray(query.schemas),
			]);

			const only = new Set(
				query.only.map((target) => `${target.schema}.${target.name}`),
			);
			const included = (schema: string, name: string): boolean =>
				only.size === 0 || only.has(`${schema}.${name}`);

			const objects: AccessObject[] = [];
			for (const row of relationRows) {
				const schema = str(row.schema);
				const name = str(row.name);
				if (!included(schema, name)) {
					continue;
				}
				const kind = str(row.kind) === "view" ? "view" : "table";
				objects.push({
					schema,
					name,
					kind,
					owner: str(row.owner),
					cells: cellsOf(row.cells),
					rls: rlsStateOf(row),
					policyCount: Number(row.policy_count ?? 0),
					// A table has no invoker option, so `null` rather than false:
					// "does not apply" and "off" are different answers.
					securityInvoker: kind === "view" ? bool(row.security_invoker) : null,
					securityDefiner: null,
					searchPathPinned: null,
					hasColumnGrants: bool(row.has_column_grants),
					domain: query.domains.get(`${kind}:${schema}.${name}`) ?? null,
				});
			}
			for (const row of routineRows) {
				const schema = str(row.schema);
				const name = str(row.name);
				if (!included(schema, name)) {
					continue;
				}
				const kind = str(row.kind) === "procedure" ? "procedure" : "function";
				objects.push({
					schema,
					name,
					kind,
					owner: str(row.owner),
					cells: cellsOf(row.cells),
					rls: "none",
					policyCount: 0,
					securityInvoker: null,
					securityDefiner: bool(row.security_definer),
					searchPathPinned: bool(row.search_path_pinned),
					hasColumnGrants: false,
					domain: query.domains.get(`${kind}:${schema}.${name}`) ?? null,
				});
			}
			objects.sort(
				(a, b) =>
					a.schema.localeCompare(b.schema) || a.name.localeCompare(b.name),
			);

			const columnGrants = new Map<string, ColumnGrant[]>();
			for (const row of columnRows) {
				const privs = privileges(row.privileges);
				if (privs.length === 0) {
					continue;
				}
				const key = `${str(row.schema)} ${str(row.name)}`;
				const list = columnGrants.get(key) ?? [];
				list.push({
					column: str(row.column_name),
					role: str(row.role_name),
					privileges: privs,
				});
				columnGrants.set(key, list);
			}

			return {
				objects,
				schemaUsage: usageRows.map((row) => ({
					schema: str(row.schema),
					roles: strings(row.roles),
				})),
				defaultAcl: defaultAclRows.map((row) => ({
					owner: str(row.owner),
					schema: row.schema === null ? null : str(row.schema),
					objectType: str(row.object_type),
					grantee: str(row.grantee),
					privileges: privileges(row.privileges),
				})),
				policies: policyRows.map((row) => ({
					schema: str(row.schema),
					table: str(row.table_name),
					name: str(row.name),
					roles: strings(row.roles),
					command: str(row.command),
					using: row.using_expr === null ? null : str(row.using_expr),
					withCheck: row.with_check === null ? null : str(row.with_check),
				})),
				viewDependencies: viewDepRows.reduce((map, row) => {
					const key = `${str(row.view_schema)}.${str(row.view_name)}`;
					const list = map.get(key) ?? [];
					list.push(`${str(row.dep_schema)}.${str(row.dep_name)}`);
					map.set(key, list);
					return map;
				}, new Map<string, string[]>()),
				columnGrants: [...columnGrants.entries()]
					.map(([key, grants]) => {
						const [schema = "", name = ""] = key.split(" ");
						return { schema, name, grants };
					})
					.sort(
						(a, b) =>
							a.schema.localeCompare(b.schema) || a.name.localeCompare(b.name),
					),
				cellCount,
			};
		} finally {
			await reserved.unsafe("ROLLBACK").catch(() => {});
		}
	} finally {
		reserved.release();
	}
}
