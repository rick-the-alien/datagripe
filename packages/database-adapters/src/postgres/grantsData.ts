import type { SQL } from "bun";
import type { TableLimits } from "../types";
import { toPgTextArray } from "./accessData";

/**
 * Canonical `GRANT` statements for the domain export
 * (docs/spec/access-report.md "Grants in the per-object DDL").
 *
 * A `CREATE FUNCTION` with no grant block does not tell a reviewer
 * whether the function is an endpoint, and under PostgREST that is the
 * only thing they needed to know. So every exported object carries its
 * grants — and grants to `PUBLIC` are written out **explicitly**,
 * including PostgreSQL's implicit default `EXECUTE` on routines. Writing
 * `GRANT EXECUTE ON FUNCTION public.login(text, text) TO PUBLIC;` when
 * nobody typed it is the point: the default becomes visible, and it
 * shows up in the diff the day a new function is added.
 *
 * Batched for the whole datasource in one query rather than per object:
 * the export already pays one `object.describe` round trip per object,
 * and a second one per object for four lines of ACL would double it.
 */

type Row = Record<string, unknown>;

/** `kind:schema.name`, matching `domainTargetKey` in contracts. */
export type GrantsByObject = Map<string, string[]>;

/**
 * Privileges in a fixed order per grantee, so the emitted line is stable
 * across exports. Order comes from the SQL (`ORDER BY ord`), not from
 * whatever order the ACL happened to be built in.
 *
 * The owner's own entry is excluded. Once any grant is made the ACL
 * materialises the owner's implicit full privileges, and emitting
 * `GRANT SELECT, INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER
 * ... TO owner;` on every object would bury the grants that are actually
 * decisions. Ownership is emitted as a one-line comment instead, so an
 * ownership change is still a visible one-line diff.
 */
const RELATION_GRANTS_SQL = `
	SELECT
		CASE c.relkind
			WHEN 'v' THEN 'view' WHEN 'm' THEN 'view'
			WHEN 'S' THEN 'sequence' ELSE 'table'
		END AS kind,
		n.nspname AS schema,
		c.relname AS name,
		CASE WHEN a.grantee = 0 THEN 'PUBLIC'
			ELSE quote_ident(pg_get_userbyid(a.grantee)) END AS grantee,
		string_agg(p.priv, ', ' ORDER BY p.ord) AS privileges,
		CASE c.relkind
			WHEN 'S' THEN 'SEQUENCE'
			WHEN 'v' THEN 'TABLE' WHEN 'm' THEN 'TABLE'
			ELSE 'TABLE'
		END AS grant_kind
	FROM pg_class c
	JOIN pg_namespace n ON n.oid = c.relnamespace
	CROSS JOIN LATERAL aclexplode(c.relacl) a
	JOIN LATERAL (
		SELECT priv, ord FROM unnest(ARRAY[
			'SELECT','INSERT','UPDATE','DELETE','TRUNCATE',
			'REFERENCES','TRIGGER','USAGE'
		]) WITH ORDINALITY AS t(priv, ord)
		WHERE t.priv = a.privilege_type
	) p ON true
	WHERE c.relkind IN ('r', 'v', 'm', 'p', 'S')
		AND n.nspname NOT LIKE 'pg\\_%'
		AND n.nspname <> 'information_schema'
		AND (cardinality($1::text[]) = 0 OR n.nspname = ANY($1::text[]))
		AND NOT EXISTS (
			SELECT 1 FROM pg_depend d WHERE d.objid = c.oid AND d.deptype = 'e'
		)
		AND a.grantee <> c.relowner
	GROUP BY c.relkind, n.nspname, c.relname, a.grantee
	ORDER BY 2, 3, 4`;

/**
 * Routines, with the implicit `PUBLIC EXECUTE` materialised.
 *
 * `proacl IS NULL` means the owner has everything *and so does PUBLIC*;
 * a naive ACL scan reports no grants for exactly the objects that are
 * most exposed. The `UNION ALL` branch below is that case, written out.
 */
const ROUTINE_GRANTS_SQL = `
	WITH routines AS (
		SELECT p.oid, p.prokind, p.proacl, p.proowner AS owner_oid,
			n.nspname AS schema,
			p.proname || '(' || pg_get_function_identity_arguments(p.oid) || ')' AS name
		FROM pg_proc p
		JOIN pg_namespace n ON n.oid = p.pronamespace
		WHERE p.prokind IN ('f', 'p')
			AND n.nspname NOT LIKE 'pg\\_%'
			AND n.nspname <> 'information_schema'
			AND (cardinality($1::text[]) = 0 OR n.nspname = ANY($1::text[]))
			AND NOT EXISTS (
				SELECT 1 FROM pg_depend d WHERE d.objid = p.oid AND d.deptype = 'e'
			)
	)
	SELECT CASE prokind WHEN 'p' THEN 'procedure' ELSE 'function' END AS kind,
		schema, name,
		CASE WHEN a.grantee = 0 THEN 'PUBLIC'
			ELSE quote_ident(pg_get_userbyid(a.grantee)) END AS grantee,
		'EXECUTE' AS privileges,
		CASE prokind WHEN 'p' THEN 'PROCEDURE' ELSE 'FUNCTION' END AS grant_kind
	FROM routines
	CROSS JOIN LATERAL aclexplode(proacl) a
	WHERE a.privilege_type = 'EXECUTE'
		AND a.grantee <> owner_oid
	UNION ALL
	-- The default nobody chose: a NULL proacl is owner-all *plus* PUBLIC
	-- EXECUTE. Emitted so the export shows it.
	SELECT CASE prokind WHEN 'p' THEN 'procedure' ELSE 'function' END AS kind,
		schema, name, 'PUBLIC' AS grantee, 'EXECUTE' AS privileges,
		CASE prokind WHEN 'p' THEN 'PROCEDURE' ELSE 'FUNCTION' END AS grant_kind
	FROM routines
	WHERE proacl IS NULL
	ORDER BY 2, 3, 4`;

/** One `-- Owner:` line per object, so ownership is in the diff. */
const OWNERS_SQL = `
	SELECT CASE c.relkind
			WHEN 'v' THEN 'view' WHEN 'm' THEN 'view'
			WHEN 'S' THEN 'sequence' ELSE 'table'
		END AS kind,
		n.nspname AS schema, c.relname AS name,
		pg_get_userbyid(c.relowner) AS owner
	FROM pg_class c
	JOIN pg_namespace n ON n.oid = c.relnamespace
	WHERE c.relkind IN ('r', 'v', 'm', 'p', 'S')
		AND n.nspname NOT LIKE 'pg\\_%'
		AND n.nspname <> 'information_schema'
		AND (cardinality($1::text[]) = 0 OR n.nspname = ANY($1::text[]))
		AND NOT EXISTS (
			SELECT 1 FROM pg_depend d WHERE d.objid = c.oid AND d.deptype = 'e'
		)
	UNION ALL
	SELECT CASE p.prokind WHEN 'p' THEN 'procedure' ELSE 'function' END,
		n.nspname,
		p.proname || '(' || pg_get_function_identity_arguments(p.oid) || ')',
		pg_get_userbyid(p.proowner)
	FROM pg_proc p
	JOIN pg_namespace n ON n.oid = p.pronamespace
	WHERE p.prokind IN ('f', 'p')
		AND n.nspname NOT LIKE 'pg\\_%'
		AND n.nspname <> 'information_schema'
		AND (cardinality($1::text[]) = 0 OR n.nspname = ANY($1::text[]))
		AND NOT EXISTS (
			SELECT 1 FROM pg_depend d WHERE d.objid = p.oid AND d.deptype = 'e'
		)`;

function str(value: unknown, fallback = ""): string {
	return typeof value === "string" ? value : fallback;
}

/**
 * A schema or object name in a `GRANT` target. Routine names already
 * carry their identity arguments — `login(text, text)` — so they cannot
 * be quoted wholesale; the bare name is emitted for those, matching what
 * the tree and the DDL show.
 */
function qualify(kind: string, schema: string, name: string): string {
	const quotedSchema = /^[a-z_][a-z0-9_]*$/.test(schema)
		? schema
		: `"${schema.replaceAll('"', '""')}"`;
	if (kind === "function" || kind === "procedure") {
		return `${quotedSchema}.${name}`;
	}
	const quotedName = /^[a-z_][a-z0-9_]*$/.test(name)
		? name
		: `"${name.replaceAll('"', '""')}"`;
	return `${quotedSchema}.${quotedName}`;
}

export async function readPostgresGrantStatements(
	client: SQL,
	limits: TableLimits,
	schemas: string[],
): Promise<GrantsByObject> {
	const reserved = await client.reserve();
	try {
		await reserved.unsafe(
			`SET statement_timeout = ${Math.max(1, Math.floor(limits.timeoutMs))}`,
		);
		await reserved.unsafe("BEGIN READ ONLY");
		try {
			const schemaParam = [toPgTextArray(schemas)];
			const relationRows = (await reserved.unsafe(
				RELATION_GRANTS_SQL,
				schemaParam,
			)) as Row[];
			const routineRows = (await reserved.unsafe(
				ROUTINE_GRANTS_SQL,
				schemaParam,
			)) as Row[];
			const ownerRows = (await reserved.unsafe(
				OWNERS_SQL,
				schemaParam,
			)) as Row[];

			const byObject: GrantsByObject = new Map();
			for (const row of ownerRows) {
				const key = `${str(row.kind)}:${str(row.schema)}.${str(row.name)}`;
				byObject.set(key, [`-- Owner: ${str(row.owner)}`]);
			}
			for (const row of [...relationRows, ...routineRows]) {
				const kind = str(row.kind);
				const schema = str(row.schema);
				const name = str(row.name);
				const grantee = str(row.grantee);
				const privileges = str(row.privileges);
				if (kind === "" || grantee === "" || privileges === "") {
					continue;
				}
				const key = `${kind}:${schema}.${name}`;
				const statement = `GRANT ${privileges} ON ${str(row.grant_kind)} ${qualify(
					kind,
					schema,
					name,
				)} TO ${grantee};`;
				const list = byObject.get(key) ?? [];
				list.push(statement);
				byObject.set(key, list);
			}
			// Sorted by grantee then privilege, per the determinism rules —
			// the SQL orders by grantee, and the list is stable within it.
			for (const list of byObject.values()) {
				list.sort();
			}
			return byObject;
		} finally {
			await reserved.unsafe("ROLLBACK").catch(() => {});
		}
	} finally {
		reserved.release();
	}
}

export { qualify as qualifyGrantTarget };
